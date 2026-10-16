import { RedactError, span } from './spans.ts';
import type { Span } from './spans.ts';

// Port of warden-redact regex_detector.rs + checks.rs: every built-in rule, same order, same patterns.

// Rust's regex crate is Unicode-aware by default (\w \d \s \b); JS is ASCII-only without help. rx() takes a Rust pattern and
// returns the equivalent JS RegExp (u flag): \w -> Alphabetic+M+Nd+Pc+Join_Control, \d -> Nd, \s -> White_Space, \b via lookarounds,
// \z -> end of input, and (?m)^/$ only at \n (JS multiline would also split on \r and U+2028/9).
const W = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}';
export function rx(pattern: string, extra = ''): RegExp {
  let flags = 'u' + extra, src = pattern, multi = false;
  for (let m: RegExpMatchArray | null; (m = /^\(\?([ims]+)\)/.exec(src)); src = src.slice(m[0].length)) {
    for (const f of m[1]) f === 'm' ? (multi = true) : (flags += f);
  }
  let out = '', inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[++i];
      out += n === 'w' ? (inClass ? W : `[${W}]`) : n === 'd' ? '\\p{Nd}' : n === 's' ? '\\p{White_Space}' : n === 'S' ? '\\P{White_Space}'
        : n === 'b' && !inClass ? `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))` : n === 'z' && !inClass ? '(?![\\s\\S])' : `\\${n}`;
    } else if (c === '[' && !inClass) { inClass = true; out += c; if (src[i + 1] === '^') out += src[++i]; if (src[i + 1] === ']') out += src[++i]; }
    else if (c === ']' && inClass) { inClass = false; out += c; }
    else if (!inClass && multi && c === '^') out += '(?<![^\\n])';
    else if (!inClass && multi && c === '$') out += '(?![^\\n])';
    else out += c;
  }
  return new RegExp(out, flags);
}

// ---- checks.rs ----
const digitsOf = (s: string) => Array.from(s).filter((c) => c >= '0' && c <= '9').map(Number); // ASCII digits only, like char::to_digit(10)

/** Luhn over the digits (non-digits ignored); 13..=19 digits, plausible first digit (2-6), not all the same digit. */
export function creditCard(s: string): boolean {
  const d = digitsOf(s);
  if (d.length < 13 || d.length > 19 || d[0] < 2 || d[0] > 6 || d.every((x) => x === d[0])) return false;
  const sum = d.reduceRight((acc, x, i) => { const pos = d.length - 1 - i; const y = pos % 2 === 1 ? x * 2 : x; return acc + (y > 9 ? y - 9 : y); }, 0);
  return sum % 10 === 0;
}

/** IBAN structure + ISO 7064 mod-97-10 check. */
export function iban(s: string): boolean {
  const c = Array.from(s).filter((x) => !/\p{White_Space}/u.test(x));
  if (c.length < 15 || c.length > 34) return false;
  let rem = 0;
  for (const ch of [...c.slice(4), ...c.slice(0, 4)]) {
    if (!/^[0-9A-Za-z]$/.test(ch)) return false;
    const v = parseInt(ch, 36);
    rem = v >= 10 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1;
}

/** Rejects placeholder-ish values for generic `key = value` assignments. */
export function plausibleSecretValue(v: string): boolean {
  const inner = v.replace(/^["']+|["']+$/g, '');
  return inner !== '' && !['true', 'false', 'null', 'none', 'nil', 'undefined'].includes(inner.toLowerCase());
}

/** Emails: skip the ubiquitous `git@host` ssh remotes. */
export const email = (v: string) => !v.startsWith('git@');

// ---- regex_detector.rs ----
// `needs`: a literal every match contains. Rust's regex engine is linear-time; JS backtracks, and the scheme/local-part rules
// (`[A-Za-z0-9+.-]*://`, `[A-Za-z0-9._%+-]+@`) rescan a long run from every start. Skipping them when the literal is absent
// keeps ordinary long runs (hex dumps, minified blobs) linear; shortcut: a huge run that also contains the literal is still quadratic.
export interface Rule { label: string; re: RegExp; group: number; validator?: (s: string) => boolean; score: number; yieldsTo: string[]; needs?: string }

export function rule(label: string, pattern: string, group = 0, opts: { validator?: (s: string) => boolean; score?: number; yieldsTo?: string[]; needs?: string } = {}): Rule {
  let re: RegExp;
  try { re = rx(pattern, 'gd'); } catch (e) { throw new RedactError(`invalid configuration: rule \`${label}\`: ${(e as Error).message}`); }
  if (group > new RegExp(`${re.source}|`, re.flags).exec('')!.length - 1) throw new RedactError(`invalid configuration: rule \`${label}\`: capture group ${group} does not exist`);
  return { label, re, group, validator: opts.validator, score: opts.score ?? 1, yieldsTo: opts.yieldsTo ?? [], needs: opts.needs };
}

const KEYWORDS = String.raw`passwor[dt]|passwd|kennwort|[_.-]pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential`;
/** Value of an assignment: double-quoted, single-quoted or bare. */
const VALUE = String.raw`"[^"]*"|'[^']*'|\S+`;
const GENERIC = String.raw`(?i)(?:(?:${KEYWORDS})[\w.-]{0,256}|auth(?:[_.-][\w.-]{0,256})?)["']?[ \t]*[:=][ \t]*(${VALUE})`;
const PK = String.raw`(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?`;
const CLI = String.raw`--(?:password|passwd|token|api[_-]?key|secret|access[_-]?key|client[_-]?secret)`;

/** Built-in rules. Order matters only for label ties (earlier wins). Generic `key = value` rules redact the value including its quotes. */
export const builtinRules = (): Rule[] => [
  rule('aws_access_key', String.raw`(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b`),
  rule('aws_secret_key', String.raw`(?i)aws_?secret_?access_?key["']?[ \t]*[=:][ \t]*["']?([A-Za-z0-9/+=]{40})`, 1),
  rule('github_token', String.raw`(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}`),
  rule('github_pat', String.raw`github_pat_[A-Za-z0-9_]{50,255}`),
  rule('gitlab_token', String.raw`glpat-[A-Za-z0-9_-]{20,}`),
  rule('slack_token', String.raw`(?:xox[abposr]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})`),
  rule('slack_webhook', String.raw`https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+`),
  rule('stripe_key', String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`),
  rule('anthropic_key', String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`),
  rule('openai_key', String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}`),
  rule('google_api_key', String.raw`AIza[0-9A-Za-z_-]{35}`),
  rule('npm_token', String.raw`npm_[A-Za-z0-9]{36}\b`),
  rule('sendgrid_key', String.raw`SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`),
  rule('huggingface_token', String.raw`hf_[A-Za-z0-9]{34,}\b`),
  rule('jwt', String.raw`eyJ[A-Za-z0-9_-]{1,8192}\.eyJ[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]*`, 0, { needs: '.eyJ' }),
  rule('private_key_block', String.raw`(?s)-----BEGIN ${PK}-----.*?(?:-----END ${PK}-----|\z)`),
  // Tail of a key block whose BEGIN line scrolled out of view.
  rule('private_key_block', String.raw`(?m)(?:^[A-Za-z0-9+/=]{16,}\r?\n)+-----END ${PK}-----`, 0, { score: 0.9, needs: '-----END' }),
  rule('authorization_header', String.raw`(?i)\bAuthorization[ \t]*:[ \t]*(?:Bearer|Basic|Token)[ \t]+([^\s"']+)`, 1),
  // The user part may be empty (`redis://:password@host`).
  rule('url_credentials', String.raw`\b[A-Za-z][A-Za-z0-9+.-]{0,31}://[^\s:/@]{0,256}:([^\s/]+)@`, 1, { needs: '://' }),
  // Token-only userinfo, e.g. Sentry DSNs `https://<key>@o1.ingest.sentry.io/1`.
  rule('url_credentials', String.raw`\b[A-Za-z][A-Za-z0-9+.-]{0,31}://([A-Za-z0-9_-]{16,})@`, 1, { needs: '://' }),
  rule('cli_secret', String.raw`(?i)${CLI}=("[^"]*"|'[^']*'|\S+)`, 1, { score: 0.9 }),
  rule('cli_secret', String.raw`(?i)${CLI}[ \t]+("[^"]*"|'[^']*'|[^\s"'-]\S*)`, 1, { score: 0.9 }),
  rule('password_hash', String.raw`\$(?:1|2[aby]|5|6|y)\$[^\s:]{8,1024}`, 0, { score: 0.95 }),
  rule('generic_secret', GENERIC, 1, { validator: plausibleSecretValue, score: 0.8 }),
  rule('credit_card', String.raw`\b(?:\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19})\b`, 0, { validator: creditCard, score: 0.9 }),
  rule('iban', String.raw`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b`, 0, { validator: iban, score: 0.9 }),
  rule('email', String.raw`\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}\b`, 0, { validator: email, score: 0.9, yieldsTo: ['url_credentials'], needs: '@' }),
];

export class RegexDetector {
  readonly name = 'regex';
  readonly rules: Rule[];
  constructor(rules: Rule[] = builtinRules()) { this.rules = rules; }

  detect(text: string): Span[] {
    const out: { idx: number; s: Span }[] = [];
    this.rules.forEach((r, idx) => {
      if (r.needs && !text.includes(r.needs)) return;
      for (const m of text.matchAll(r.re)) {
        const g = r.group === 0 ? ([m.index!, m.index! + m[0].length] as [number, number]) : (m as any).indices[r.group];
        if (!g || g[0] >= g[1]) continue;
        if (r.validator && !r.validator(text.slice(g[0], g[1]))) continue;
        out.push({ idx, s: span(g[0], g[1], r.label, 'regex', r.score) });
      }
    });
    const keep = ({ idx, s }: { idx: number; s: Span }) => {
      const y = this.rules[idx].yieldsTo;
      return !y.length || !out.some(({ s: o }) => y.includes(o.label) && o.start < s.end && s.start < o.end);
    };
    return out.filter(keep).map(({ s }) => s);
  }
}
