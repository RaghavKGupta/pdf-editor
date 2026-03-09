import { useState, useEffect, useRef, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import SignatureModal from './SignatureModal'
import TextEditLayer from './TextEditLayer'
import { exportPdf } from '../utils/pdfExport'

// Set worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const TOOLS = {
  SELECT: 'select',
  EDIT: 'edit',
  TEXT: 'text',
  SIGNATURE: 'signature',
}

export default function PdfEditor({ pdfData, fileName }) {
  const [pdfDoc, setPdfDoc] = useState(null)
  const [pages, setPages] = useState([])
  const [scale, setScale] = useState(1.2)
  const [activeTool, setActiveTool] = useState(TOOLS.SELECT)
  const [annotations, setAnnotations] = useState({})
  const [showSignatureModal, setShowSignatureModal] = useState(false)
  const [savedSignature, setSavedSignature] = useState(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState(null)
  const [formFields, setFormFields] = useState({})
  const [formValues, setFormValues] = useState({})

  // Text editing state: extracted text items per page and user edits
  const [pageTextItems, setPageTextItems] = useState({}) // { pageNum: [{ id, str, x, y, width, height, fontName, fontSize, transform }] }
  const [textEdits, setTextEdits] = useState({}) // { "pageNum-itemId": newText }

  const canvasRefs = useRef({})
  const dragRef = useRef(null)

  // Load PDF
  useEffect(() => {
    let cancelled = false
    async function loadPdf() {
      setLoading(true)
      try {
        const doc = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise
        if (cancelled) return
        setPdfDoc(doc)

        const pagePromises = []
        for (let i = 1; i <= doc.numPages; i++) {
          pagePromises.push(doc.getPage(i))
        }
        const loadedPages = await Promise.all(pagePromises)
        if (cancelled) return
        setPages(loadedPages)

        // Extract form fields
        const fields = {}
        for (const page of loadedPages) {
          const annots = await page.getAnnotations()
          const pageFields = annots.filter(a =>
            a.subtype === 'Widget' &&
            (a.fieldType === 'Tx' || a.fieldType === 'Btn' || a.fieldType === 'Ch')
          )
          if (pageFields.length > 0) {
            fields[page.pageNumber] = pageFields
          }
        }
        setFormFields(fields)

        const values = {}
        for (const [, pageFieldList] of Object.entries(fields)) {
          for (const field of pageFieldList) {
            if (field.fieldValue) {
              values[field.id] = field.fieldValue
            }
          }
        }
        setFormValues(values)

        // Extract text content from each page, including font style info
        const allTextItems = {}
        for (const page of loadedPages) {
          const textContent = await page.getTextContent()
          const viewport = page.getViewport({ scale: 1 }) // base scale=1 for PDF coords
          const styles = textContent.styles || {} // fontName → { fontFamily, ascent, descent }
          const items = []

          textContent.items.forEach((item, idx) => {
            if (!item.str || !item.str.trim()) return

            // item.transform = [scaleX, skewY, skewX, scaleY, translateX, translateY]
            const tx = item.transform
            const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1])
            const x = tx[4]
            const y = tx[5]

            // Width comes from item.width (in PDF units)
            const width = item.width
            const height = item.height || fontSize * 1.2

            // Get CSS font family from pdfjs style info
            const style = styles[item.fontName] || {}
            const fontFamily = style.fontFamily || ''

            items.push({
              id: idx,
              str: item.str,
              x,
              y, // PDF y (from bottom)
              width,
              height,
              fontSize,
              fontName: item.fontName || '',
              fontFamily, // actual CSS font family from the PDF
              transform: tx,
              // Store original for export diffing
              originalStr: item.str,
            })
          })

          if (items.length > 0) {
            allTextItems[page.pageNumber] = items
          }
        }
        setPageTextItems(allTextItems)
      } catch (err) {
        console.error('Failed to load PDF:', err)
        showToast('Failed to load PDF')
      }
      setLoading(false)
    }
    loadPdf()
    return () => { cancelled = true }
  }, [pdfData])

  // Render pages at high DPI for sharp text
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    pages.forEach((page) => {
      const canvas = canvasRefs.current[page.pageNumber]
      if (!canvas) return
      const viewport = page.getViewport({ scale })
      // Set canvas backing store to dpr × CSS size for crisp rendering
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = viewport.width + 'px'
      canvas.style.height = viewport.height + 'px'
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      page.render({ canvasContext: ctx, viewport }).promise
    })
  }, [pages, scale])

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }, [])

  // Handle click on page to add annotations
  const handlePageClick = useCallback((e, pageNum) => {
    if (activeTool === TOOLS.SELECT || activeTool === TOOLS.EDIT) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (activeTool === TOOLS.TEXT) {
      const newAnnotation = {
        id: Date.now().toString(),
        type: 'text',
        x,
        y,
        text: '',
        fontSize: 14,
        color: '#000000',
      }
      setAnnotations(prev => ({
        ...prev,
        [pageNum]: [...(prev[pageNum] || []), newAnnotation]
      }))
    } else if (activeTool === TOOLS.SIGNATURE && savedSignature) {
      const newAnnotation = {
        id: Date.now().toString(),
        type: 'signature',
        x: x - 50,
        y: y - 20,
        dataUrl: savedSignature,
        width: 150,
        height: 60,
      }
      setAnnotations(prev => ({
        ...prev,
        [pageNum]: [...(prev[pageNum] || []), newAnnotation]
      }))
      showToast('Signature placed!')
    } else if (activeTool === TOOLS.SIGNATURE && !savedSignature) {
      setShowSignatureModal(true)
    }
  }, [activeTool, savedSignature, showToast])

  const updateAnnotation = useCallback((pageNum, id, updates) => {
    setAnnotations(prev => ({
      ...prev,
      [pageNum]: (prev[pageNum] || []).map(a =>
        a.id === id ? { ...a, ...updates } : a
      )
    }))
  }, [])

  const deleteAnnotation = useCallback((pageNum, id) => {
    setAnnotations(prev => ({
      ...prev,
      [pageNum]: (prev[pageNum] || []).filter(a => a.id !== id)
    }))
  }, [])

  // Drag handling for annotations
  const handleDragStart = useCallback((e, pageNum, annotId) => {
    e.stopPropagation()
    const rect = e.currentTarget.parentElement.getBoundingClientRect()
    dragRef.current = {
      pageNum,
      annotId,
      offsetX: e.clientX - e.currentTarget.getBoundingClientRect().left,
      offsetY: e.clientY - e.currentTarget.getBoundingClientRect().top,
      parentRect: rect,
    }

    const onMove = (ev) => {
      if (!dragRef.current) return
      const { pageNum: pn, annotId: aid, offsetX, offsetY, parentRect } = dragRef.current
      const newX = ev.clientX - parentRect.left - offsetX
      const newY = ev.clientY - parentRect.top - offsetY
      updateAnnotation(pn, aid, { x: Math.max(0, newX), y: Math.max(0, newY) })
    }

    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [updateAnnotation])

  // Text edit handler
  const handleTextEdit = useCallback((pageNum, itemId, newText) => {
    const key = `${pageNum}-${itemId}`
    setTextEdits(prev => ({
      ...prev,
      [key]: newText,
    }))
  }, [])

  // Export PDF
  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      const blob = await exportPdf(pdfData, annotations, formValues, formFields, scale, textEdits, pageTextItems)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName.replace('.pdf', '') + '_edited.pdf'
      a.click()
      URL.revokeObjectURL(url)
      showToast('PDF downloaded!')
    } catch (err) {
      console.error('Export failed:', err)
      showToast('Export failed. Please try again.')
    }
    setExporting(false)
  }, [pdfData, annotations, formValues, formFields, scale, fileName, showToast, textEdits, pageTextItems])

  const handleSignatureSave = useCallback((dataUrl) => {
    setSavedSignature(dataUrl)
    setShowSignatureModal(false)
    setActiveTool(TOOLS.SIGNATURE)
    showToast('Signature ready — click on a page to place it')
  }, [showToast])

  const zoomIn = () => setScale(s => Math.min(3, s + 0.2))
  const zoomOut = () => setScale(s => Math.max(0.4, s - 0.2))

  const hasFormFields = Object.keys(formFields).length > 0
  const editCount = Object.keys(textEdits).length

  return (
    <>
      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-group">
          <span className="toolbar-label">Tools</span>
          <button
            className={`btn-icon ${activeTool === TOOLS.SELECT ? 'active' : ''}`}
            onClick={() => setActiveTool(TOOLS.SELECT)}
            title="Select / Move"
          >
            ↖
          </button>
          <button
            className={`btn-icon ${activeTool === TOOLS.EDIT ? 'active' : ''}`}
            onClick={() => setActiveTool(TOOLS.EDIT)}
            title="Edit existing text"
            style={{ fontWeight: 700, fontStyle: 'italic' }}
          >
            ✎
          </button>
          <button
            className={`btn-icon ${activeTool === TOOLS.TEXT ? 'active' : ''}`}
            onClick={() => setActiveTool(TOOLS.TEXT)}
            title="Add Text"
          >
            T
          </button>
          <button
            className={`btn-icon ${activeTool === TOOLS.SIGNATURE ? 'active' : ''}`}
            onClick={() => {
              if (!savedSignature) {
                setShowSignatureModal(true)
              } else {
                setActiveTool(TOOLS.SIGNATURE)
              }
            }}
            title="Signature"
          >
            ✍
          </button>
        </div>

        {activeTool === TOOLS.EDIT && (
          <div className="toolbar-group">
            <span style={{ fontSize: 12, color: 'var(--primary)' }}>
              Click on any text to edit it
              {editCount > 0 && <> &middot; {editCount} edit{editCount !== 1 ? 's' : ''}</>}
            </span>
          </div>
        )}

        {savedSignature && (
          <div className="toolbar-group">
            <button
              className="btn btn-secondary"
              onClick={() => setShowSignatureModal(true)}
              style={{ fontSize: 12 }}
            >
              Change Signature
            </button>
          </div>
        )}

        <div className="toolbar-group">
          <span className="toolbar-label">Zoom</span>
          <div className="zoom-controls">
            <button className="btn-icon" onClick={zoomOut} title="Zoom Out">−</button>
            <span className="zoom-value">{Math.round(scale * 100)}%</span>
            <button className="btn-icon" onClick={zoomIn} title="Zoom In">+</button>
          </div>
        </div>

        {hasFormFields && (
          <div className="toolbar-group">
            <span style={{ fontSize: 12, color: 'var(--primary)' }}>
              📋 Form fields detected
            </span>
          </div>
        )}

        <div style={{ flex: 1 }} />

        <button className="btn btn-primary" onClick={handleExport} disabled={exporting}>
          {exporting ? 'Exporting…' : '⬇ Download PDF'}
        </button>
      </div>

      {/* PDF Pages */}
      <div className="pdf-viewer-container">
        <div className="pdf-pages-scroll">
          {loading && (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <div className="spinner" />
              <p className="loading-text">Loading PDF…</p>
            </div>
          )}

          {pages.map((page) => {
            const viewport = page.getViewport({ scale })
            const pageAnnots = annotations[page.pageNumber] || []
            const pageFormFields = formFields[page.pageNumber] || []

            return (
              <div key={page.pageNumber} className="pdf-page-wrapper">
                <canvas
                  ref={el => { canvasRefs.current[page.pageNumber] = el }}
                  style={{ width: viewport.width, height: viewport.height }}
                />

                {/* Text edit layer — shown when Edit tool is active */}
                {activeTool === TOOLS.EDIT && (
                  <TextEditLayer
                    pageNum={page.pageNumber}
                    textItems={pageTextItems[page.pageNumber] || []}
                    textEdits={textEdits}
                    onEdit={handleTextEdit}
                    scale={scale}
                    pageHeight={page.getViewport({ scale: 1 }).height}
                    viewportHeight={viewport.height}
                  />
                )}

                {/* Form fields layer */}
                {pageFormFields.map((field) => {
                  const [x1, y1, x2, y2] = field.rect
                  const vs = page.getViewport({ scale })
                  const left = x1 * scale
                  const bottom = y1 * scale
                  const width = (x2 - x1) * scale
                  const height = (y2 - y1) * scale
                  const top = vs.height - bottom - height

                  return (
                    <div
                      key={field.id}
                      className="form-field-highlight"
                      style={{ left, top, width, height }}
                    >
                      {field.fieldType === 'Tx' && (
                        <input
                          className="form-field-input"
                          type="text"
                          placeholder={field.alternativeText || field.fieldName || ''}
                          value={formValues[field.id] || ''}
                          onChange={(e) => {
                            setFormValues(prev => ({ ...prev, [field.id]: e.target.value }))
                          }}
                        />
                      )}
                      {field.fieldType === 'Btn' && (
                        <input
                          type="checkbox"
                          checked={!!formValues[field.id]}
                          onChange={(e) => {
                            setFormValues(prev => ({ ...prev, [field.id]: e.target.checked }))
                          }}
                          style={{ width: '100%', height: '100%', cursor: 'pointer' }}
                        />
                      )}
                    </div>
                  )
                })}

                {/* Annotations layer (add text / signatures) */}
                <div
                  className={`annotations-layer ${(activeTool === TOOLS.TEXT || activeTool === TOOLS.SIGNATURE) ? 'interactive' : ''}`}
                  onClick={(e) => handlePageClick(e, page.pageNumber)}
                >
                  {pageAnnots.map((annot) => {
                    if (annot.type === 'text') {
                      return (
                        <div
                          key={annot.id}
                          className="text-annotation"
                          style={{ left: annot.x, top: annot.y }}
                          onMouseDown={(e) => {
                            if (activeTool === TOOLS.SELECT) {
                              handleDragStart(e, page.pageNumber, annot.id)
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <textarea
                            className="text-annotation-input"
                            value={annot.text}
                            placeholder="Type here…"
                            style={{ fontSize: annot.fontSize, color: annot.color }}
                            onChange={(e) => {
                              updateAnnotation(page.pageNumber, annot.id, { text: e.target.value })
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                          />
                          <button
                            className="delete-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteAnnotation(page.pageNumber, annot.id)
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )
                    }

                    if (annot.type === 'signature') {
                      return (
                        <div
                          key={annot.id}
                          className="signature-annotation"
                          style={{ left: annot.x, top: annot.y }}
                          onMouseDown={(e) => handleDragStart(e, page.pageNumber, annot.id)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <img
                            src={annot.dataUrl}
                            alt="Signature"
                            style={{ width: annot.width, height: annot.height }}
                            draggable={false}
                          />
                          <button
                            className="delete-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteAnnotation(page.pageNumber, annot.id)
                            }}
                          >
                            ✕
                          </button>
                          <div
                            className="resize-handle"
                            onMouseDown={(e) => {
                              e.stopPropagation()
                              const startX = e.clientX
                              const startW = annot.width
                              const startH = annot.height
                              const ratio = startW / startH
                              const onMove = (ev) => {
                                const dx = ev.clientX - startX
                                const newW = Math.max(50, startW + dx)
                                updateAnnotation(page.pageNumber, annot.id, {
                                  width: newW,
                                  height: newW / ratio,
                                })
                              }
                              const onUp = () => {
                                document.removeEventListener('mousemove', onMove)
                                document.removeEventListener('mouseup', onUp)
                              }
                              document.addEventListener('mousemove', onMove)
                              document.addEventListener('mouseup', onUp)
                            }}
                          />
                        </div>
                      )
                    }
                    return null
                  })}
                </div>

                {/* Page number */}
                <div style={{
                  textAlign: 'center', padding: '6px 0', fontSize: 12,
                  color: 'var(--text-secondary)', background: '#f8f8f8',
                  borderTop: '1px solid #eee',
                }}>
                  Page {page.pageNumber} of {pages.length}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {showSignatureModal && (
        <SignatureModal
          onSave={handleSignatureSave}
          onClose={() => setShowSignatureModal(false)}
        />
      )}

      {exporting && (
        <div className="loading-overlay">
          <div className="spinner" />
          <p className="loading-text">Building your PDF…</p>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
