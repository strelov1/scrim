# scrim

A minimal headless browser for AI agents. One binary, no layout, no paint.

An agent reading a web page needs its text, its links and its controls. It does not need pixels.
scrim drops everything that exists only to produce them — layout, painting, images, fonts,
animations — and keeps everything that decides *what the page says*: the DOM, page JavaScript,
the cascade rules that hide content, cookies, navigation and forms.

On a 34-task agent suite it passes everything headless Chrome passes, reads visible text with
100.0 % recall and 99.9 % precision against Chrome's `innerText`, starts in ~13 ms on an article
with scripts, and peaks at 69 MB over the whole suite where Chrome peaks at 973 MB.

## Usage

```sh
scrim fetch <url> [--dump text|markdown|snapshot|html|links] [--eval js]
scrim fetch <url> --screenshot out.png [--width W] [--height H] [--full-page]
scrim serve                           # JSON lines on stdin/stdout, one long-lived session
scrim --session DIR <command> [args]  # stateless: one process per call, no daemon
```

Commands in `serve` and `--session`: `goto` `click` `fill` `select` `press` `scroll` `back`
`forward` `reload` `eval` `wait` `text` `markdown` `snapshot` `links` `html` `url` `cookies`.

Elements are addressed the way an agent sees them in a snapshot, not by brittle CSS:

```sh
scrim --session /tmp/s goto https://example.com/jobs
scrim --session /tmp/s snapshot                      # accessibility-style tree with refs
scrim --session /tmp/s click 'role=button:All filters'
scrim --session /tmp/s fill 'label=Email' me@example.com
scrim --session /tmp/s text
```

Locators: `role=button:Save`, `label=Email`, `text=Continue`, `css=.foo`, or a `ref` from the
snapshot such as `e152`.

## Build

Needs a Rust toolchain. On macOS the prebuilt V8 archive requires a 14.0 deployment target:

```sh
MACOSX_DEPLOYMENT_TARGET=14.0 cargo build --release --manifest-path scrim/Cargo.toml
```

`./cargo.sh build --release --manifest-path scrim/Cargo.toml` does the same with a repo-local
`CARGO_HOME` and an empty environment, so the build depends on nothing outside the checkout.
The first build downloads a prebuilt `librusty_v8.a` (~147 MB); V8 itself is not compiled.

## How it works

- **No layout, no paint, no images or fonts.** Nothing an agent reads depends on them.
- **CSS reduced to what hides content.** Only `display`, `visibility` and `content-visibility`
  are kept; `@media` is evaluated at a fixed 1280×800.
- **No JavaScript engine for script-less pages.** Their cascade and text are computed in Rust
  (`src/native.rs`), a line-by-line port of `js/style.js` and `js/agent.js`. Setting
  `SCRIM_NO_NATIVE=1` forces the JS path; the two are kept byte-identical.
- **The engine fits the page.** QuickJS for kilobytes of script because it starts faster; V8 above
  256 KB because a JIT pays off for megabytes. One V8 isolate per process, reused.
- **Virtual time.** With nothing in flight the clock jumps to the next timer, so `setTimeout`
  chains and debounces cost nothing.
- **Settle, don't poll.** Every action returns once microtasks, network, timers, navigations and
  frames are quiet.

Screenshots are the one exception: on request the current DOM is styled, laid out and painted by
[Blitz](https://github.com/DioxusLabs/blitz) (`scrim/src/render.rs`). Reading still needs no layout.

## Layout

| Path | What |
|---|---|
| `scrim/src/` | the Rust engine: parsing, CSS, network, JS hosts, native read path, rendering |
| `scrim/js/` | the JS platform the page runs against: DOM, HTML, style, window, agent |

The corpus, the 34-task suite and the comparison harness the numbers above come from live in a
separate research repository; this one is the browser.

## Known limits

- **Dynamic `import()` from a classic inline script fails** (`Error resolving module … from
  'eval_script'`): the resolver gets the eval's name instead of the document URL. Module scripts
  are fine. This is how Vite-built apps bootstrap, so SvelteKit, Astro and similar pages serve
  their SSR HTML correctly but never hydrate.
- No WebGL, canvas pixels, media playback, service workers or extensions.
- Screenshots use the host's installed fonts; a page's webfonts load, but emoji coverage depends
  on the machine.

## Name

A scrim is the theatre gauze that looks like a solid wall or turns transparent depending on where
the light is. Same idea here: the page's content comes through, its presentation does not.

## License

MIT — see [LICENSE](LICENSE).
