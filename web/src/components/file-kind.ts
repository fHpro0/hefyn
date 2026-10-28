import { File, FileArchive, FileAudio, FileCode, FileCog, FileImage, FileJson, FileSpreadsheet, FileText, FileType2, FileVideo, Folder, Presentation, type LucideIcon } from 'lucide-react';

export type Preview = 'dir' | 'markdown' | 'code' | 'csv' | 'image' | 'pdf' | 'audio' | 'video' | 'none';
export interface Kind { icon: LucideIcon; label: string; preview: Preview; lang?: string; mime?: string }

const set = (exts: string, k: Kind): [string, Kind][] => exts.split(' ').map((e) => [e, k]);
const code = (exts: string, label: string, lang?: string) => set(exts, { icon: FileCode, label, preview: 'code', lang });
const KINDS = new Map<string, Kind>([
  ...set('png jpg jpeg gif webp avif', { icon: FileImage, label: 'Image', preview: 'image' }),
  ...set('svg', { icon: FileImage, label: 'SVG image', preview: 'image', mime: 'image/svg+xml' }),
  ...set('heic', { icon: FileImage, label: 'HEIC image', preview: 'none' }),
  ...set('pdf', { icon: FileType2, label: 'PDF', preview: 'pdf', mime: 'application/pdf' }),
  ...set('md markdown', { icon: FileText, label: 'Markdown', preview: 'markdown', lang: 'markdown' }),
  ...set('txt log', { icon: FileText, label: 'Text', preview: 'code' }),
  ...set('rtf', { icon: FileText, label: 'Rich text', preview: 'none' }),
  ...set('docx doc odt pages', { icon: FileText, label: 'Document', preview: 'none' }),
  ...set('pptx key odp', { icon: Presentation, label: 'Presentation', preview: 'none' }),
  ...set('csv tsv', { icon: FileSpreadsheet, label: 'Spreadsheet', preview: 'csv' }),
  ...set('xlsx xls ods numbers', { icon: FileSpreadsheet, label: 'Spreadsheet', preview: 'none' }),
  ...set('json', { icon: FileJson, label: 'JSON', preview: 'code', lang: 'json' }),
  ...set('yaml yml', { icon: FileCog, label: 'YAML', preview: 'code', lang: 'yaml' }),
  ...set('toml xml ini env', { icon: FileCog, label: 'Config', preview: 'code' }),
  ...code('ts', 'TypeScript', 'typescript'), ...code('tsx', 'TypeScript', 'tsx'), ...code('js mjs cjs', 'JavaScript', 'javascript'), ...code('jsx', 'JavaScript', 'jsx'),
  ...code('py', 'Python', 'python'), ...code('sh', 'Shell', 'bash'), ...code('sql', 'SQL', 'sql'), ...code('html', 'HTML', 'html'), ...code('css', 'CSS', 'css'),
  ...code('go', 'Go'), ...code('rs', 'Rust'), ...code('java', 'Java'), ...code('c h', 'C'), ...code('cpp', 'C++'), ...code('cs', 'C#'), ...code('rb', 'Ruby'), ...code('php', 'PHP'), ...code('swift', 'Swift'), ...code('kt', 'Kotlin'),
  ...set('zip tar gz tgz 7z rar', { icon: FileArchive, label: 'Archive', preview: 'none' }),
  ...set('mp3 wav m4a ogg flac aac', { icon: FileAudio, label: 'Audio', preview: 'audio' }),
  ...set('mp4 mov webm mkv avi m4v', { icon: FileVideo, label: 'Video', preview: 'video' }),
]);

export const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** Icon, label and how the viewer shows a file. HTML is "code": it is shown as text, never rendered. */
export function kindOf(name: string, dir = false): Kind {
  if (dir) return { icon: Folder, label: 'Folder', preview: 'dir' };
  const ext = extOf(name);
  const k = KINDS.get(ext);
  if (k) return { ...k, mime: k.mime ?? (k.preview === 'image' ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : k.preview === 'audio' ? `audio/${ext === 'mp3' ? 'mpeg' : ext === 'm4a' ? 'mp4' : ext}` : k.preview === 'video' ? `video/${ext === 'mov' ? 'quicktime' : ext === 'mkv' ? 'x-matroska' : ext === 'avi' ? 'x-msvideo' : ext === 'm4v' ? 'mp4' : ext}` : undefined) };
  return { icon: File, label: ext ? `${ext.toUpperCase()} file` : 'File', preview: 'none' };
}
