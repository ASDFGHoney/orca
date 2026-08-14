# Split BrowserPane.tsx under 400 lines

Hard goal: `src/renderer/src/components/browser-pane/BrowserPane.tsx` `wc -l` <= 400, and every new dest file `wc -l` <= 400. Oxlint: `.tsx` 400 / `.ts` 300 counted lines — keep new `.ts` files under 300 `wc -l`.

Zero intentional behavior change. Cut/paste + imports. Keep why-comments. No max-lines disables or budget bumps.

## Baseline (Phase A)

- Branch: `split-browser-pane`, clean
- Source: 5739 lines
- `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/browser-pane` → 45 files / 344 tests passed
- `pnpm run typecheck:web` → passed
- Note: `pnpm test -- path` does not forward the filter through `&&`; use `pnpm exec vitest` for focused runs

## Public API (must stay importable from `./BrowserPane`)

- `export default function BrowserPane`
- `export type BrowserFindShortcutScope`
- Consumers: `BrowserPaneOverlayLayer.tsx`, `Terminal.tsx`, `FloatingBrowserSlot.tsx`

## Source-scanning tests (retarget dest files)

- `BrowserPane.render-ipc.test.ts` → `function BrowserPagePane` + `const isBlankTab =` in `browser-page/browser-page-pane.tsx`. Keep `isBlankTab` and the next `useEffect(() => {` in that same file.
- `BrowserPane.remote-link-routing.test.ts` → `function RemoteBrowserPagePane` + `void openWorkspaceBrowserTab({` in `remote-browser-page/remote-browser-page-pane.tsx` (same file as the function).
- `feature-interaction-writer-boundaries.test.ts` → dest that still contains `handleBrowserAnnotationsSentToAgent` / `handleClearBrowserAnnotations` / `handleCopyBrowserAnnotations` / `handleDeleteBrowserAnnotation` in that order, with a single `recordFeatureInteraction('browser-annotations-sent-to-agent')`.
- `hover-reveal-touch-action-visibility.test.ts` → dest that still contains the annotation-tray `can-hover:opacity-0` hover-reveal line.

## Folder map

```
browser-pane/
  BrowserPane.tsx                         # thin orchestrator only
  browser-page/
    browser-page-types.ts
    browser-page-url-display.ts
    browser-page-url-display.test.ts
    browser-download-progress.ts
    browser-download-progress.test.ts
    browser-annotation-geometry.ts
    browser-annotation-geometry.test.ts
    browser-page-load-error.ts
    browser-page-load-error.test.ts
    browser-overlay-shortcut-target.ts
    browser-overlay-shortcut-target.test.ts
    prevent-agent-send-target-outside-dismiss.ts
    pending-browser-annotation-card.tsx
    browser-page-pane.tsx
    browser-page-toolbar.tsx
    browser-page-context-menu.tsx
    browser-page-chrome-banners.tsx
    browser-page-viewport-overlays.tsx
    use-browser-page-webview-lifecycle.ts
    use-browser-page-keyboard-shortcuts.ts
    use-browser-page-grab-annotations.ts
    use-browser-page-navigation-downloads.ts
  remote-browser-page/
    remote-browser-page-input-model.ts
    remote-browser-page-input-model.test.ts
    remote-browser-page-pane.tsx
    remote-browser-page-toolbar.tsx
    remote-browser-page-context-menu.tsx
    remote-browser-page-viewport.tsx
    use-remote-browser-page-stream.ts
    use-remote-browser-page-input.ts
    use-remote-browser-page-navigation.ts
```

## Line-range → dest (source inventory)

| Lines | Symbol / block | Dest |
|------|----------------|------|
| 223–234 | `BrowserTabPageState`, `BrowserPageUrlSetter` | `browser-page/browser-page-types.ts` |
| 236–252 | `BrowserDownloadState`, `formatBrowserDownloadProgress` | `browser-page/browser-download-progress.ts` |
| 254–392 | overlay/annotation geometry + constants | `browser-page/browser-annotation-geometry.ts` |
| 394–541 | `PendingBrowserAnnotationCard` | `browser-page/pending-browser-annotation-card.tsx` |
| 543–560 | `RemoteBrowserStreamBridge` | `remote-browser-page/remote-browser-page-input-model.ts` |
| 563–579 | `browserPageExists`, `buildLoadError` | `browser-page/browser-page-load-error.ts` |
| 581–719 | URL/title/retry/runtime-id | `browser-page/browser-page-url-display.ts` |
| 289–337, 607–691 | remote input/decode/context-menu parse | `remote-browser-page/remote-browser-page-input-model.ts` |
| 721–734 | `BrowserFindShortcutScope`, `browserOverlayOwnsShortcutTarget` | types + `browser-overlay-shortcut-target.ts` |
| 736–856 | `BrowserPane` | **stay in source** |
| 858–2381 | `RemoteBrowserPagePane` | `remote-browser-page/` then split |
| 2383–2395 | `preventAgentSendTargetOutsideDismiss` | `browser-page/prevent-agent-send-target-outside-dismiss.ts` |
| 2397–5739 | `BrowserPagePane` | `browser-page/` then split |

## What remains in BrowserPane.tsx

Imports + `export type { BrowserFindShortcutScope }` + `export default function BrowserPane` (~120 LOC body). Target ~180–220 lines.

## Circular-import policy

- Types/pure modules import only `@/`, `shared/`, and sibling leaf modules. They never import pane components.
- Pane components import hooks and presentational chunks. Hooks do not import pane components.
- Thin `BrowserPane.tsx` imports the two pane components and `getBrowserPageRuntimeEnvironmentId`. No reverse import.

## Pass 1 — extract leaves + move panes

1. Characterization tests for uncovered pure symbols
2. Cut/paste module-level types/functions/card
3. Move each pane wholesale into its domain folder (source becomes thin)
4. Fix relative imports (`./x` → `../x`, `../../../../shared` → `../../../../../shared`)

## Pass 2 — split oversized dest files

Remote pane (~1523): extract toolbar / context menu / viewport JSX; extract stream / input / navigation hooks.

Local pane (~3342):
- JSX: context menu 4686–4839; toolbar 4841–5187; banners 5188–5343; viewport overlays 5344–5736
- Hooks: webview lifecycle 3339–3927; keyboard/focus 2939–3331; grab+annotations 4048–4412; navigation+downloads 4414–4670

Each hook takes explicit args/refs (no shared “ctx bag” type file named helpers/utils).

## Characterization tests (uncovered pures)

- url display, download progress, annotation geometry, load error, overlay shortcut target, remote input model

Skip store-coupled `browserPageExists` and DOM Image `decodeRemoteBrowserFrameUrl`.

## Verification

```bash
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/browser-pane
pnpm run typecheck:web
pnpm run check:max-lines-ratchet --prune
wc -l src/renderer/src/components/browser-pane/BrowserPane.tsx
wc -l src/renderer/src/components/browser-pane/browser-page/*.{ts,tsx}
wc -l src/renderer/src/components/browser-pane/remote-browser-page/*.{ts,tsx}
```

After removing `/* eslint-disable max-lines */` from the source, prune `config/max-lines-baseline.txt`.

## Commit (if green)

`refactor: split BrowserPane.tsx under 400 lines`
