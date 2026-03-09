# PDF Editor

A free, open-source PDF editor that runs entirely in your browser. No server uploads, no accounts, no subscriptions — your files never leave your device.

## Why this exists

PDF editing shouldn't cost $20/month. It shouldn't require handing your sensitive documents to a company that mines your data for profit. Most "free" PDF editors are just funnels into expensive subscriptions, and the ones that do work often upload your files to remote servers with vague privacy policies.

This project exists because editing a PDF should be simple, private, and free. Everything runs 100% client-side in your browser. Your documents are never uploaded anywhere.

## Features

- **Edit existing text** — Click on any text in your PDF and change it inline. The editor preserves the original font, size, and styling from each text element.
- **Add new text** — Place new text boxes anywhere on any page.
- **Signatures** — Draw a signature by hand or type one with your choice of font. Place and resize it anywhere.
- **Fill PDF forms** — Automatically detects form fields (text inputs, checkboxes) and lets you fill them in.
- **Multi-page support** — Scroll through and edit all pages at once.
- **Zoom controls** — Scale the view from 40% to 300%.
- **Download edited PDF** — Export your changes as a new PDF file with fonts preserved.

## Privacy

This is the core principle of the project:

- **Zero server uploads** — The app is static HTML/JS/CSS. There is no backend. Your PDFs are processed entirely in your browser's memory.
- **No tracking** — No analytics, no cookies, no telemetry.
- **No accounts** — Nothing to sign up for. Just open the app and use it.
- **Open source** — Every line of code is right here. Audit it yourself.

## Tech stack

- **React** — UI framework
- **pdf.js** (Mozilla) — Renders PDFs in the browser and extracts text/font data
- **pdf-lib** — Modifies and exports PDFs client-side
- **@pdf-lib/fontkit** — Extracts and re-embeds original fonts from the PDF so edited text matches the original styling
- **Vite** — Build tool

## How font preservation works

When you edit text, the app:

1. Extracts the actual embedded font programs (TrueType, OpenType, CFF) from the original PDF
2. Re-embeds them using fontkit so the replacement text uses the exact same font
3. Falls back to the closest matching standard font (Helvetica, Times, Courier) only if the original font can't be extracted

This means if your PDF uses Calibri, Garamond, or any other embedded font, the edited text should look the same — not get replaced with generic Helvetica.

## Getting started

```bash
# Clone the repo
git clone https://github.com/your-username/pdf-editor.git
cd pdf-editor

# Install dependencies
npm install

# Start the dev server
npm run dev

# Build for production
npm run build
```

## License

MIT — use it however you want.
