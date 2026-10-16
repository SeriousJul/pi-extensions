# Fonts in this directory

The four `MesloLGMDZNFMono-*.ttf` files are the Regular, Italic, Bold, and
BoldItalic styles of **MesloLGMDZ Nerd Font Mono**, the Nerd Fonts build of
Meslo LG M for Powerline that SeriousJul's terminals (ghostty, foot,
alacritty, kitty) render with.

- Upstream base font: **Meslo LG** (Masayuki Horie), licensed under the SIL
  Open Font License, 1.1.
- Nerd Font patches: [nerd-fonts/nerd-fonts](https://github.com/ryanoasis/nerd-fonts),
  licensed under the SIL Open Font License, 1.1.
- The committed bytes are the font files of the Arch Linux package
  `ttf-meslo-nerd` (version 3.5.1), the same files the author's machine
  loads from /usr/share/fonts/TTF.

Full text of the license: [SIL Open Font License 1.1](https://openfontlicense.org/).

The capture pipeline (`scripts/screenshots/render-png.mjs`) embeds these exact
files into every rendered PNG so that screenshots reproduce identically on any
machine, as required by [ADR 0017](../../../docs/adr/0017-docs-screenshots-render-by-capture-pipeline.md).
Do not replace them with a system font.
