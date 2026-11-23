# site-generator-speed-01

A faster drop-in for make.fun's own makefun-site 1.0.0: it builds the same
static site — the same output tree, byte for byte — from the same input,
with less CPU time. Front matter and Markdown are read in one pass with no
token objects, inline rendering escapes whole plain runs at once, slugs are
memoised, templates are parsed once into flat node arrays and rendered into
a chunk list, and templates that only read the case's root values
(site, tags, recent) are rendered once per case and cached.

Run: `node main.ts` reads `/input/cases.json` and writes
`/output/answers.json`, one answer per case, in the cases' order.
