---
name: openui
description: "Use whenever a reply has structured results (tables, comparisons, choices for the user, forms, status cards) to render them as interactive UI in the hefyn chat with an ```openui block."
---
In the hefyn chat you can show interactive UI instead of plain text. Write it as OpenUI Lang inside a fenced code block tagged openui. Text around the block is normal markdown.

## Syntax Rules

1. Each statement is on its own line: `identifier = Expression`
2. `root` is the entry point — every program must define `root = Stack(...)`
3. Expressions are: strings ("..."), numbers, booleans (true/false), null, arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)
4. Use references for readability: define `name = ...` on one line, then use `name` later
5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.
6. Arguments are POSITIONAL (order matters, not names). Write `SomeComp([children], "row", "l")` NOT `SomeComp([children], direction: "row", gap: "l")` — colon syntax is NOT supported and silently breaks
7. Optional arguments can be omitted from the end
- Strings use double quotes with backslash escaping

## Component Signatures

Arguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.
Props typed `ActionExpression` accept one @step, or Action([@steps...]) for several. See the Action section for available steps (@ToAssistant, @OpenUrl).

Stack(children: any[], direction?: "column" | "row", gap?: "sm" | "md" | "lg") — Lays children out in a column (default) or a row. Use as the root.
Card(title?: string, children: any[]) — A bordered box with an optional title around its children.
Heading(text: string) — A heading.
Text(text: string, muted?: boolean) — A paragraph of plain text (no markdown).
Tag(text: string, tone?: "neutral" | "ok" | "warn" | "bad") — A small status label. tone: neutral, ok, warn or bad.
DataTable(columns: string[], rows: (string | number)[][]) — A table: column titles and rows, each row a list of cells in column order.
KeyValue(items: (string | number)[][]) — Labelled facts or stats: a list of [label, value] pairs.
Button(label: string, action?: ActionExpression, variant?: "primary" | "outline") — A button. Without an action it sends its label to the assistant. Inside a Form it also sends the form values.
Choices(options: string[]) — A row of quick-reply buttons. Clicking one sends that option text to the assistant as the answer. Best way to ask the user to pick.
Form(name: string, children: any[]) — Groups fields and a submit Button. A Button inside sends every field value to the assistant. name is a short unique id.
TextField(name: string, label: string, placeholder?: string) — A one-line text input inside a Form. name is the key its value is sent under.
SelectField(name: string, label: string, options: string[]) — A dropdown inside a Form: one of the options.
CheckField(name: string, label: string) — A checkbox inside a Form; its value is true or false.

## Action — Button Behavior

An action wires a button click to operations. Pass one @-prefixed step bare, e.g. Button("Ask", @ToAssistant("Tell me more")). Put several steps in Action([...]), e.g. Button("Read", Action([@OpenUrl("https://example.com"), @ToAssistant("Summarize this page")])). Steps execute in order.
Buttons without an action automatically send their label to the assistant (equivalent to @ToAssistant(label)).

Available steps:
- @ToAssistant(message: string, context?: any) — Send a message to the assistant (for conversational buttons like "Tell me more", "Explain this"). The optional context is any value (object, array, string, number) passed to the assistant as hidden data, e.g. @ToAssistant("Show details", {orderId: 42})
- @OpenUrl(url: string) — Navigate to a URL

Example — simple nav:
```
viewBtn = Button("View", @OpenUrl("https://example.com"))
```

- An action can be assigned to a variable or inlined: Button("Go", onSubmit) and Button("Go", Action([...])) both work

## Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. `root = Stack(...)` — UI shell appears immediately
2. Component definitions — fill in as they stream
3. Data values — leaf content last

Always write the root = Stack(...) statement first so the UI shell appears immediately, even before child data has streamed in.

## Examples

```openui
root = Stack([card, ask])
card = Card("Build status", [KeyValue([["Branch", "main"], ["Tests", "42 passed"]]), Tag("green", "ok")])
ask = Choices(["Deploy", "Wait", "Show the log"])
```

## Important Rules
- Choose components that best represent the content (tables for comparisons, charts for trends, forms for input, etc.)

## Final Verification
Before finishing, walk your output and verify:
1. root = Stack(...) is the FIRST line (for optimal streaming).
2. Every referenced name is defined. Every defined name (other than root) is reachable from root.

- Put the OpenUI Lang in a ```openui fenced block in your reply, never outside one. One block per reply is usually enough; add a sentence of normal text before or after it.
- Use it for tables, comparisons, status cards, choices the user should pick from (Choices), and forms. Plain answers stay plain text.
- A click sends a message back to you: Choices and Button send their label, a Button inside a Form also sends every field as "name: value". Treat that message as the user's answer.
- There are no images, iframes or links to load. To offer a link, use a Button with @OpenUrl("https://...").
