# Attribution and licenses

This is an independent DeepSeek Harness adapter for Huashu Design. It is not an official Huashu release. The adapter implements its own native React workbench and library; no third-party workbench source code or artwork is redistributed.

The unmodified upstream snapshot in `upstream/` comes from https://github.com/alchaincyf/huashu-design at commit `e8d1148a80d5a281d4247cffe320add3df017928` (v3.3.0). Its main code, documentation and assets use the MIT License, with copyright retained in `upstream/LICENSE`.

Exception: the 22 bird sticker images in `upstream/assets/style-specimens/xhs/_kit/stickers/` use PolyForm Shield License 1.0.0 and are NOT covered by the upstream MIT License. Preserve the original `LICENSE.md` and Required Notice. The upstream author says to replace these demo stickers with your own materials in final deliverables.

Required Notice: Copyright (c) 2026 Huashu (alchaincyf), https://github.com/alchaincyf/huashu-bird-sticker

License reference: https://polyformproject.org/licenses/shield/1.0.0

The Client bundle includes the Marked 15.0.12 GFM lexer. Its full original license and copyright notices are distributed in [dist/marked-LICENSE.md](dist/marked-LICENSE.md); the generated JavaScript retains its legal comments. The bundle does not execute source HTML from handbooks.

The embedded PrintPress views are adapted at build time from the user's local PrintPress project (`printpress` 0.7.1, author lyq, MIT according to its package manifest). Original business source files are not overwritten. The generated Client also includes the Vue 3.5 runtime, Copyright (c) 2018-present Yuxi (Evan) You, under the MIT License retained in `dist/printpress/Vue-LICENSE.txt`. Electron, ONNX Runtime and model files stay in the existing PrintPress installation and retain its third-party notices.

The finalized PrintPress mark traces the cream "P + stacked sheets" silhouette from the user's `electron/brand/printpress-logo-v2.png` (SHA-256 `ff0db4a915d605878779cc706f126700fa696fa53614c4b59b0711e95c039671`) into a compact theme-adaptive vector path. The original PNG remains in the PrintPress installation and is not copied into or redistributed by this adapter; only the traced silhouette is shipped.

The adapter's original icon and code use the root MIT License. Runtime dependencies retain their own licenses. The full snapshot and per-file hashes are recorded in `upstream-manifest.json`.
