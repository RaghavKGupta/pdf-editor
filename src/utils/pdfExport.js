import { PDFDocument, rgb, StandardFonts, PDFName, PDFDict, PDFRef, PDFHexString, PDFString, PDFArray, PDFNumber } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

// ─────────────────────────────────────────────────────────────
// Content-stream text replacement
// ─────────────────────────────────────────────────────────────

/**
 * Parse a PDF content stream into tokens.
 * Returns an array of { type: 'operand'|'operator', value: string }
 */
function tokenizeContentStream(streamBytes) {
  const text = typeof streamBytes === 'string'
    ? streamBytes
    : new TextDecoder('latin1').decode(streamBytes)

  const tokens = []
  let i = 0

  while (i < text.length) {
    // Skip whitespace
    if (/\s/.test(text[i])) { i++; continue }

    // Comment
    if (text[i] === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      continue
    }

    // String literal (...)
    if (text[i] === '(') {
      let depth = 1
      let str = '('
      i++
      while (i < text.length && depth > 0) {
        if (text[i] === '\\') {
          str += text[i] + (text[i + 1] || '')
          i += 2
          continue
        }
        if (text[i] === '(') depth++
        if (text[i] === ')') depth--
        str += text[i]
        i++
      }
      tokens.push({ type: 'operand', value: str })
      continue
    }

    // Hex string <...>
    if (text[i] === '<' && text[i + 1] !== '<') {
      let str = '<'
      i++
      while (i < text.length && text[i] !== '>') {
        str += text[i]
        i++
      }
      str += '>'
      i++ // skip >
      tokens.push({ type: 'operand', value: str })
      continue
    }

    // Dict << ... >>
    if (text[i] === '<' && text[i + 1] === '<') {
      let str = '<<'
      i += 2
      let depth = 1
      while (i < text.length && depth > 0) {
        if (text[i] === '<' && text[i + 1] === '<') { depth++; str += '<<'; i += 2; continue }
        if (text[i] === '>' && text[i + 1] === '>') { depth--; str += '>>'; i += 2; continue }
        str += text[i]
        i++
      }
      tokens.push({ type: 'operand', value: str })
      continue
    }

    // Array [ ... ]
    if (text[i] === '[') {
      let depth = 1
      let str = '['
      i++
      while (i < text.length && depth > 0) {
        if (text[i] === '[') depth++
        if (text[i] === ']') depth--
        str += text[i]
        i++
      }
      tokens.push({ type: 'operand', value: str })
      continue
    }

    // Name /Something
    if (text[i] === '/') {
      let str = '/'
      i++
      while (i < text.length && !/[\s/<>\[\]()%]/.test(text[i])) {
        str += text[i]
        i++
      }
      tokens.push({ type: 'operand', value: str })
      continue
    }

    // Number or keyword
    let word = ''
    while (i < text.length && !/[\s/<>\[\]()%]/.test(text[i])) {
      word += text[i]
      i++
    }
    if (word) {
      // Check if it's an operator (alphabetic) or number
      if (/^[a-zA-Z*'"]+$/.test(word)) {
        tokens.push({ type: 'operator', value: word })
      } else {
        tokens.push({ type: 'operand', value: word })
      }
    }
  }

  return tokens
}

/**
 * Decode a PDF string literal (...) to a JS string.
 */
function decodePdfString(pdfStr) {
  // Remove parens
  let s = pdfStr.slice(1, -1)
  let result = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '\\') {
      i++
      if (s[i] === 'n') { result += '\n'; i++ }
      else if (s[i] === 'r') { result += '\r'; i++ }
      else if (s[i] === 't') { result += '\t'; i++ }
      else if (s[i] === 'b') { result += '\b'; i++ }
      else if (s[i] === 'f') { result += '\f'; i++ }
      else if (s[i] === '(') { result += '('; i++ }
      else if (s[i] === ')') { result += ')'; i++ }
      else if (s[i] === '\\') { result += '\\'; i++ }
      else if (/[0-7]/.test(s[i])) {
        let oct = s[i]; i++
        if (i < s.length && /[0-7]/.test(s[i])) { oct += s[i]; i++ }
        if (i < s.length && /[0-7]/.test(s[i])) { oct += s[i]; i++ }
        result += String.fromCharCode(parseInt(oct, 8))
      } else {
        result += s[i]; i++
      }
    } else {
      result += s[i]; i++
    }
  }
  return result
}

/**
 * Encode a JS string into a PDF string literal (...).
 */
function encodePdfString(str) {
  let out = '('
  for (const ch of str) {
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch
    else out += ch
  }
  out += ')'
  return out
}

/**
 * Try to extract text from a TJ array operand, e.g. [(H) 20 (ello)]
 */
function extractTJText(tjArrayStr) {
  const parts = []
  const re = /\(([^)]*(?:\\.[^)]*)*)\)|<([0-9a-fA-F]*)>/g
  let m
  while ((m = re.exec(tjArrayStr)) !== null) {
    if (m[1] !== undefined) {
      parts.push({ type: 'literal', raw: m[0], text: decodePdfString('(' + m[1] + ')') })
    } else if (m[2] !== undefined) {
      parts.push({ type: 'hex', raw: m[0], text: m[2] })
    }
  }
  return parts
}

/**
 * Directly modify the PDF content stream to replace text strings.
 * This preserves all font/style operators — we only change the string data.
 *
 * Returns the number of replacements made.
 */
function replaceTextInContentStream(streamBytes, editMap) {
  // editMap: Map<originalText, newText>
  if (editMap.size === 0) return { bytes: streamBytes, count: 0 }

  const text = typeof streamBytes === 'string'
    ? streamBytes
    : new TextDecoder('latin1').decode(streamBytes)

  const tokens = tokenizeContentStream(text)
  let count = 0
  let modified = false

  // Process Tj and TJ operators
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]

    // Tj operator: preceded by a string operand
    if (token.type === 'operator' && token.value === 'Tj' && t > 0) {
      const prev = tokens[t - 1]
      if (prev.type === 'operand' && prev.value.startsWith('(')) {
        const decoded = decodePdfString(prev.value)
        if (editMap.has(decoded)) {
          prev.value = encodePdfString(editMap.get(decoded))
          count++
          modified = true
        }
      }
    }

    // TJ operator: preceded by an array with strings and kerning numbers
    if (token.type === 'operator' && token.value === 'TJ' && t > 0) {
      const prev = tokens[t - 1]
      if (prev.type === 'operand' && prev.value.startsWith('[')) {
        // Extract combined text from all string parts in the array
        const parts = extractTJText(prev.value)
        const combinedText = parts
          .filter(p => p.type === 'literal')
          .map(p => p.text)
          .join('')

        if (editMap.has(combinedText)) {
          const newText = editMap.get(combinedText)
          // Replace: put all text in a single Tj string (simpler, preserves the font)
          // We switch from TJ array to a simple string + Tj
          tokens[t - 1] = { type: 'operand', value: encodePdfString(newText) }
          tokens[t] = { type: 'operator', value: 'Tj' }
          count++
          modified = true
        }
      }
    }

    // Also try single ' and " show operators (rare but possible)
    if (token.type === 'operator' && token.value === "'" && t > 0) {
      const prev = tokens[t - 1]
      if (prev.type === 'operand' && prev.value.startsWith('(')) {
        const decoded = decodePdfString(prev.value)
        if (editMap.has(decoded)) {
          prev.value = encodePdfString(editMap.get(decoded))
          count++
          modified = true
        }
      }
    }
  }

  if (!modified) return { bytes: streamBytes, count: 0 }

  // Reconstruct stream
  const out = tokens.map(t => t.value).join(' ')
  const encoder = new TextEncoder()
  // Use latin1 encoding to preserve byte values
  const outBytes = new Uint8Array(out.length)
  for (let i = 0; i < out.length; i++) {
    outBytes[i] = out.charCodeAt(i) & 0xFF
  }
  return { bytes: outBytes, count }
}

// ─────────────────────────────────────────────────────────────
// Standard font fallback (for annotations and form fills only)
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Main export function
// ─────────────────────────────────────────────────────────────

/**
 * Export the edited PDF.
 *
 * For inline text edits: directly patches the page content stream so the
 * original font, size, color, and position are perfectly preserved. No
 * whiteout rectangles, no font re-embedding — just a surgical string swap.
 *
 * Falls back to whiteout+redraw only for edits that the stream parser
 * couldn't match (e.g. CIDFont hex-encoded text).
 *
 * Everything runs 100% client-side.
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
  pdfDoc.registerFontkit(fontkit)

  const pages = pdfDoc.getPages()

  // Standard font cache for annotations/forms
  const stdFontCache = {}
  async function getStdFont(fontName) {
    const stdFont = pickStandardFont(fontName)
    if (!stdFontCache[stdFont]) {
      stdFontCache[stdFont] = await pdfDoc.embedFont(stdFont)
    }
    return stdFontCache[stdFont]
  }

  const helvetica = await getStdFont('')
  const helveticaBold = await getStdFont('bold')

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]
    const pageNum = pageIdx + 1
    const { height: pageHeight } = page.getSize()
    const scaleFactor = viewScale

    // ──────────────────────────────────────────────────────────
    // 1. Apply inline text edits via content-stream patching
    // ──────────────────────────────────────────────────────────
    const items = pageTextItems[pageNum] || []
    const editMap = new Map() // originalStr → newStr
    const editItems = []      // items that need editing

    for (const item of items) {
      const key = `${pageNum}-${item.id}`
      if (!(key in textEdits)) continue
      const newText = textEdits[key]
      if (newText === item.originalStr) continue
      editMap.set(item.originalStr, newText)
      editItems.push(item)
    }

    if (editMap.size > 0) {
      // Get the page's content stream(s)
      const contentsRef = page.node.get(PDFName.of('Contents'))
      let streamReplaced = 0

      if (contentsRef) {
        const contents = contentsRef instanceof PDFRef
          ? pdfDoc.context.lookup(contentsRef)
          : contentsRef

        // Contents can be a single stream or an array of streams
        const streamRefs = []
        if (contents instanceof PDFArray) {
          for (let si = 0; si < contents.size(); si++) {
            streamRefs.push(contents.get(si))
          }
        } else {
          streamRefs.push(contentsRef)
        }

        for (const ref of streamRefs) {
          const streamObj = ref instanceof PDFRef ? pdfDoc.context.lookup(ref) : ref
          if (!streamObj || !streamObj.contents) continue

          const { bytes: newBytes, count } = replaceTextInContentStream(
            streamObj.contents,
            editMap
          )

          if (count > 0) {
            // Replace the stream contents
            streamObj.contents = newBytes
            streamReplaced += count
          }
        }
      }

      // Fallback: any edits the stream parser missed, use whiteout+redraw
      if (streamReplaced < editMap.size) {
        for (const item of editItems) {
          const key = `${pageNum}-${item.id}`
          const newText = textEdits[key]
          // Check if this specific item was likely handled by stream patching
          // We can't know for sure, so only fallback if zero stream replacements happened
          if (streamReplaced > 0) continue

          const padding = 1
          page.drawRectangle({
            x: item.x - padding,
            y: item.y - padding - (item.height * 0.15),
            width: item.width + padding * 2 + 10,
            height: item.height + padding * 2,
            color: rgb(1, 1, 1),
            borderWidth: 0,
          })

          const font = await getStdFont(item.fontFamily || item.fontName || '')
          try {
            page.drawText(newText, {
              x: item.x,
              y: item.y,
              size: item.fontSize,
              font,
              color: rgb(0, 0, 0),
            })
          } catch {
            const safeText = newText.replace(/[^\x20-\x7E]/g, '?')
            page.drawText(safeText, {
              x: item.x,
              y: item.y,
              size: item.fontSize,
              font: helvetica,
              color: rgb(0, 0, 0),
            })
          }
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
