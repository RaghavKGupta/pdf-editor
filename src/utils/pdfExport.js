import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * Export the edited PDF with all annotations, form values, AND inline text edits baked in.
 * For text edits: draws a white rectangle over the original text, then draws the new text.
 * Everything runs client-side.
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
  const pages = pdfDoc.getPages()

  // Embed fonts upfront
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]
    const pageNum = pageIdx + 1
    const { width: pageWidth, height: pageHeight } = page.getSize()
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
        y: item.y - padding - (item.height * 0.15), // slight offset below baseline
        width: item.width + padding * 2 + 10, // little extra to fully cover
        height: item.height + padding * 2,
        color: rgb(1, 1, 1), // white
        borderWidth: 0,
      })

      // Choose font — try to match bold if font name suggests it
      const isBold = item.fontName && /bold/i.test(item.fontName)
      const font = isBold ? helveticaBold : helvetica

      // Draw the new text at the same position
      const fontSize = item.fontSize
      try {
        page.drawText(newText, {
          x: item.x,
          y: item.y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        })
      } catch (err) {
        // Fallback: some chars might not be in the standard font
        // Try with basic ASCII filtering
        const safeText = newText.replace(/[^\x20-\x7E]/g, '?')
        page.drawText(safeText, {
          x: item.x,
          y: item.y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        })
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
        const [x1, y1, x2, y2] = field.rect
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
