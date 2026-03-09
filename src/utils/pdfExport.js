import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * Export the edited PDF with all annotations and form values baked in.
 * Everything runs client-side — no server needed.
 */
export async function exportPdf(originalPdfData, annotations, formValues, formFields, viewScale) {
  // Load the original PDF
  const pdfDoc = await PDFDocument.load(originalPdfData, { ignoreEncryption: true })
  const pages = pdfDoc.getPages()
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]
    const pageNum = pageIdx + 1
    const { width: pageWidth, height: pageHeight } = page.getSize()

    // Calculate the viewport dimensions at the given scale
    // We need to convert from screen coords (at viewScale) back to PDF coords
    const scaleFactor = viewScale

    // Apply text annotations
    const pageAnnots = annotations[pageNum] || []
    for (const annot of pageAnnots) {
      if (annot.type === 'text' && annot.text.trim()) {
        // Convert screen coords to PDF coords
        const pdfX = annot.x / scaleFactor
        // PDF y-axis is from bottom, screen y is from top
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
            font,
            color: rgb(r, g, b),
          })
        })
      }

      if (annot.type === 'signature' && annot.dataUrl) {
        try {
          // Decode the base64 data URL
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

    // Fill form field values by drawing text on top
    const pageFormFields = formFields[pageNum] || []
    for (const field of pageFormFields) {
      const value = formValues[field.id]
      if (!value) continue

      if (field.fieldType === 'Tx' && typeof value === 'string' && value.trim()) {
        const [x1, y1, x2, y2] = field.rect
        const fieldWidth = x2 - x1
        const fieldHeight = y2 - y1
        const fontSize = Math.min(fieldHeight * 0.7, 12)

        page.drawText(value, {
          x: x1 + 2,
          y: y1 + fieldHeight * 0.25,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        })
      }

      if (field.fieldType === 'Btn' && value === true) {
        const [x1, y1, x2, y2] = field.rect
        const midX = (x1 + x2) / 2
        const midY = (y1 + y2) / 2
        const size = Math.min(x2 - x1, y2 - y1) * 0.6

        page.drawText('✓', {
          x: midX - size / 2,
          y: midY - size / 2,
          size,
          font,
          color: rgb(0, 0, 0),
        })
      }
    }
  }

  // Try to flatten form fields so filled values show
  try {
    const form = pdfDoc.getForm()
    const fields = form.getFields()
    for (const field of fields) {
      const name = field.getName()
      // Set text field values from our form values
      for (const [, pageFieldList] of Object.entries(formFields)) {
        for (const pf of pageFieldList) {
          if (pf.fieldName === name && formValues[pf.id]) {
            try {
              if (pf.fieldType === 'Tx') {
                const tf = form.getTextField(name)
                tf.setText(formValues[pf.id])
              }
            } catch { /* field may not be settable */ }
          }
        }
      }
    }
    form.flatten()
  } catch {
    // PDF may not have interactive form fields, that's fine
  }

  const pdfBytes = await pdfDoc.save()
  return new Blob([pdfBytes], { type: 'application/pdf' })
}
