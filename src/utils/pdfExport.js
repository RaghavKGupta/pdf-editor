import { PDFDocument, rgb, StandardFonts, PDFName, PDFDict, PDFRef } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

/**
 * Map a PDF font name to the best matching StandardFont (last-resort fallback).
 */
function pickStandardFont(fontName) {
  const name = (fontName || '').toLowerCase()
  const isBold = /bold/.test(name)
  const isItalic = /italic|oblique/.test(name)

  if (/times|serif|roman|garamond|georgia|cambria|palatino/.test(name)) {
    if (isBold && isItalic) return StandardFonts.TimesRomanBoldItalic
    if (isBold) return StandardFonts.TimesRomanBold
    if (isItalic) return StandardFonts.TimesRomanItalic
    return StandardFonts.TimesRoman
  }

  if (/courier|mono|consolas|menlo|source\s?code/.test(name)) {
    if (isBold && isItalic) return StandardFonts.CourierBoldOblique
    if (isBold) return StandardFonts.CourierBold
    if (isItalic) return StandardFonts.CourierOblique
    return StandardFonts.Courier
  }

  if (isBold && isItalic) return StandardFonts.HelveticaBoldOblique
  if (isBold) return StandardFonts.HelveticaBold
  if (isItalic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

/**
 * Normalize a font name for matching: strip subset prefix (ABCDEF+), remove
 * spaces/hyphens, and lowercase.
 */
function normalizeFontName(name) {
  return (name || '')
    .replace(/^[A-Z]{6}\+/, '') // strip subset prefix like "BCDEFG+"
    .replace(/[-_\s]/g, '')
    .toLowerCase()
}

/**
 * Attempt to extract all embedded font programs from every page of the PDF.
 * Returns a map of normalizedBaseFontName → embeddedFont.
 *
 * Strategy:
 *  - Walk each page's Resources → Font dictionary
 *  - For each font, locate its FontDescriptor
 *  - Pull the raw font program out of FontFile2 (TrueType), FontFile3 (CFF/OTF),
 *    or FontFile (Type1)
 *  - Re-embed via fontkit so we can use it in drawText()
 */
async function extractEmbeddedFonts(pdfDoc) {
  const extracted = {} // normalizedName → embeddedFont

  function resolve(ref) {
    if (ref instanceof PDFRef) return pdfDoc.context.lookup(ref)
    return ref
  }

  try {
    const pages = pdfDoc.getPages()
    for (const page of pages) {
      const resources = resolve(page.node.get(PDFName.of('Resources')))
      if (!(resources instanceof PDFDict)) continue

      const fontDict = resolve(resources.get(PDFName.of('Font')))
      if (!(fontDict instanceof PDFDict)) continue

      for (const [, valueRef] of fontDict.entries()) {
        try {
          const fontObj = resolve(valueRef)
          if (!(fontObj instanceof PDFDict)) continue

          // Get the BaseFont name (e.g. /TimesNewRomanPSMT, /ABCDEF+Calibri-Bold)
          const baseFontRaw = fontObj.get(PDFName.of('BaseFont'))
          if (!baseFontRaw) continue
          const baseFontName = baseFontRaw.toString().replace(/^\//, '')
          const normalizedName = normalizeFontName(baseFontName)

          // Skip if already extracted
          if (extracted[normalizedName]) continue

          // Handle Type0 (composite) fonts — the actual font data is in DescendantFonts
          let descriptorSource = fontObj
          const subtypeRaw = fontObj.get(PDFName.of('Subtype'))
          const subtype = subtypeRaw ? subtypeRaw.toString().replace(/^\//, '') : ''

          if (subtype === 'Type0') {
            const descendantsRef = fontObj.get(PDFName.of('DescendantFonts'))
            const descendants = resolve(descendantsRef)
            if (descendants && typeof descendants.get === 'function') {
              // It's a PDFArray — get the first element
              descriptorSource = resolve(descendants.get(0)) || fontObj
            } else if (Array.isArray(descendants)) {
              descriptorSource = resolve(descendants[0]) || fontObj
            }
          }

          // Get FontDescriptor
          const descriptorRef = descriptorSource instanceof PDFDict
            ? descriptorSource.get(PDFName.of('FontDescriptor'))
            : null
          if (!descriptorRef) continue

          const descriptor = resolve(descriptorRef)
          if (!(descriptor instanceof PDFDict)) continue

          // Try each font file type: TrueType → OpenType/CFF → Type1
          let fontBytes = null
          for (const fileKey of ['FontFile2', 'FontFile3', 'FontFile']) {
            const fileRef = descriptor.get(PDFName.of(fileKey))
            if (!fileRef) continue

            const stream = resolve(fileRef)
            if (!stream) continue

            // pdf-lib stream objects store decoded bytes in .contents
            const bytes = stream.contents || stream.getContents?.()
            if (bytes && bytes.length > 50) {
              fontBytes = bytes
              break
            }
          }

          if (!fontBytes) continue

          // Embed via fontkit — may fail for heavily subsetted or corrupt fonts
          const embeddedFont = await pdfDoc.embedFont(fontBytes, { subset: false })
          extracted[normalizedName] = embeddedFont

          // Also store without subset prefix variations
          const withoutPlus = baseFontName.replace(/^[A-Z]{6}\+/, '')
          extracted[normalizeFontName(withoutPlus)] = embeddedFont
        } catch {
          // Individual font extraction failed — continue to next font
        }
      }
    }
  } catch {
    // Global extraction failure — we'll fall back to standard fonts
  }

  return extracted
}

/**
 * Export the edited PDF with all annotations, form values, AND inline text edits baked in.
 *
 * Font handling priority:
 *  1. Extract the actual embedded font from the original PDF and re-embed it (exact match)
 *  2. Fall back to the closest matching PDF standard font
 *
 * Everything runs 100% client-side — your data never leaves your browser.
 */
export async function exportPdf(
  originalPdfData,
  annotations,
  formValues,
  formFields,
  viewScale,
  textEdits = {},
  pageTextItems = {}
) {
  const pdfDoc = await PDFDocument.load(originalPdfData, { ignoreEncryption: true })

  // Register fontkit so we can embed custom (non-standard) fonts
  pdfDoc.registerFontkit(fontkit)

  const pages = pdfDoc.getPages()

  // ─── Extract original embedded fonts from the PDF ───
  const embeddedFonts = await extractEmbeddedFonts(pdfDoc)

  // ─── Standard-font fallback cache ───
  const stdFontCache = {}
  async function getStdFont(fontName) {
    const stdFont = pickStandardFont(fontName)
    if (!stdFontCache[stdFont]) {
      stdFontCache[stdFont] = await pdfDoc.embedFont(stdFont)
    }
    return stdFontCache[stdFont]
  }

  /**
   * Resolve the best font to use for a text item.
   * Tries the extracted embedded font first, falls back to standard.
   */
  async function resolveFont(item) {
    // Try matching by fontName (pdfjs internal name often contains the real name)
    const nameNorm = normalizeFontName(item.fontName || '')
    if (embeddedFonts[nameNorm]) return embeddedFonts[nameNorm]

    // Try matching by fontFamily (extracted from pdfjs styles, e.g. "Times New Roman")
    const familyNorm = normalizeFontName(item.fontFamily || '')
    if (embeddedFonts[familyNorm]) return embeddedFonts[familyNorm]

    // Try partial matching: check if any extracted font name contains the family
    if (familyNorm) {
      for (const [key, font] of Object.entries(embeddedFonts)) {
        if (key.includes(familyNorm) || familyNorm.includes(key)) {
          return font
        }
      }
    }

    // Last resort: best-matching standard font
    return getStdFont(item.fontFamily || item.fontName || '')
  }

  // Pre-embed Helvetica for annotations/forms
  const helvetica = await getStdFont('')
  const helveticaBold = await getStdFont('bold')

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]
    const pageNum = pageIdx + 1
    const { height: pageHeight } = page.getSize()
    const scaleFactor = viewScale

    // ──────────────────────────────────────────────
    // 1. Apply inline text edits (whiteout + redraw)
    // ──────────────────────────────────────────────
    const items = pageTextItems[pageNum] || []
    for (const item of items) {
      const key = `${pageNum}-${item.id}`
      if (!(key in textEdits)) continue
      const newText = textEdits[key]
      if (newText === item.originalStr) continue // no change

      // Draw a white rectangle to cover the original text
      const padding = 1
      page.drawRectangle({
        x: item.x - padding,
        y: item.y - padding - (item.height * 0.15),
        width: item.width + padding * 2 + 10,
        height: item.height + padding * 2,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      })

      // Resolve the best matching font for this specific text item
      const font = await resolveFont(item)
      const fontSize = item.fontSize

      try {
        page.drawText(newText, {
          x: item.x,
          y: item.y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        })
      } catch {
        // If the extracted font doesn't contain the needed glyphs (subset issue),
        // fall back to standard font
        try {
          const fallbackFont = await getStdFont(item.fontFamily || item.fontName || '')
          page.drawText(newText, {
            x: item.x,
            y: item.y,
            size: fontSize,
            font: fallbackFont,
            color: rgb(0, 0, 0),
          })
        } catch {
          // Ultimate fallback: filter to safe ASCII
          const safeText = newText.replace(/[^\x20-\x7E]/g, '?')
          page.drawText(safeText, {
            x: item.x,
            y: item.y,
            size: fontSize,
            font: helvetica,
            color: rgb(0, 0, 0),
          })
        }
      }
    }

    // ──────────────────────────────────────
    // 2. Apply text annotations (new boxes)
    // ──────────────────────────────────────
    const pageAnnots = annotations[pageNum] || []
    for (const annot of pageAnnots) {
      if (annot.type === 'text' && annot.text.trim()) {
        const pdfX = annot.x / scaleFactor
        const pdfY = pageHeight - (annot.y / scaleFactor) - (annot.fontSize || 14)
        const lines = annot.text.split('\n')
        const fontSize = (annot.fontSize || 14) / scaleFactor * 0.75
        const colorHex = annot.color || '#000000'
        const r = parseInt(colorHex.slice(1, 3), 16) / 255
        const g = parseInt(colorHex.slice(3, 5), 16) / 255
        const b = parseInt(colorHex.slice(5, 7), 16) / 255

        lines.forEach((line, lineIdx) => {
          page.drawText(line, {
            x: pdfX,
            y: pdfY - lineIdx * (fontSize * 1.4),
            size: fontSize,
            font: helvetica,
            color: rgb(r, g, b),
          })
        })
      }

      if (annot.type === 'signature' && annot.dataUrl) {
        try {
          const base64Data = annot.dataUrl.split(',')[1]
          const imgBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))
          const pngImage = await pdfDoc.embedPng(imgBytes)

          const pdfX = annot.x / scaleFactor
          const sigWidth = (annot.width || 150) / scaleFactor
          const sigHeight = (annot.height || 60) / scaleFactor
          const pdfY = pageHeight - (annot.y / scaleFactor) - sigHeight

          page.drawImage(pngImage, {
            x: pdfX,
            y: pdfY,
            width: sigWidth,
            height: sigHeight,
          })
        } catch (err) {
          console.warn('Failed to embed signature:', err)
        }
      }
    }

    // ──────────────────────────────────
    // 3. Fill form field values
    // ──────────────────────────────────
    const pageFormFields = formFields[pageNum] || []
    for (const field of pageFormFields) {
      const value = formValues[field.id]
      if (!value) continue

      if (field.fieldType === 'Tx' && typeof value === 'string' && value.trim()) {
        const [x1, y1, , y2] = field.rect
        const fieldHeight = y2 - y1
        const fontSize = Math.min(fieldHeight * 0.7, 12)

        page.drawText(value, {
          x: x1 + 2,
          y: y1 + fieldHeight * 0.25,
          size: fontSize,
          font: helvetica,
          color: rgb(0, 0, 0),
        })
      }

      if (field.fieldType === 'Btn' && value === true) {
        const [x1, y1, x2, y2] = field.rect
        const midX = (x1 + x2) / 2
        const midY = (y1 + y2) / 2
        const size = Math.min(x2 - x1, y2 - y1) * 0.6

        page.drawText('X', {
          x: midX - size / 3,
          y: midY - size / 3,
          size,
          font: helveticaBold,
          color: rgb(0, 0, 0),
        })
      }
    }
  }

  // Flatten form fields
  try {
    const form = pdfDoc.getForm()
    const fields = form.getFields()
    for (const field of fields) {
      const name = field.getName()
      for (const [, pageFieldList] of Object.entries(formFields)) {
        for (const pf of pageFieldList) {
          if (pf.fieldName === name && formValues[pf.id]) {
            try {
              if (pf.fieldType === 'Tx') {
                form.getTextField(name).setText(formValues[pf.id])
              }
            } catch { /* field may not be settable */ }
          }
        }
      }
    }
    form.flatten()
  } catch {
    // PDF may not have interactive form fields
  }

  const pdfBytes = await pdfDoc.save()
  return new Blob([pdfBytes], { type: 'application/pdf' })
}
