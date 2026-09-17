# Fonts in this directory

The four `MesloLGMDZNFMono-*.ttf` files are the Regular, Italic, Bold, and
BoldItalic styles of **Meslo LG M for Powerline** (Nerd Font Mono cut),
distributed by the [Nerd Fonts](https://www.nerdfonts.com/) project.

- Upstream base font: **Meslo LG** (Masayuki Horie), licensed under the SIL
  Open Font License, 1.1.
- Nerd Font patches: [nerd-fonts/patched-fonts](https://github.com/nerd-fonts/patched-fonts),
  licensed under the SIL Open Font License, 1.1.

Full text of the license: [SIL Open Font License 1.1](https://openfontlicense.org/).

The capture pipeline (`scripts/screenshots/render-png.mjs`) embeds these exact
files into every rendered PNG so that screenshots reproduce identically on any
machine, as required by [ADR 0017](../../../docs/adr/0017-docs-screenshots-render-by-capture-pipeline.md).
Do not replace them with a system font.
