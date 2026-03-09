import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * Renders an overlay of clickable text items extracted from the PDF.
 * When the Edit tool is active, each text item becomes a hoverable region.
 * Clicking a text item turns it into an editable input.
 *
 * Props:
 *  - pageNum: current page number
 *  - textItems: array of { id, str, x, y, width, height, fontSize, originalStr }
 *  - textEdits: { "pageNum-itemId": newText } map of edits
 *  - onEdit(pageNum, itemId, newText): callback when text is changed
 *  - scale: current zoom scale
 *  - pageHeight: PDF page height in PDF units (unscaled)
 *  - viewportHeight: rendered viewport height in px
 */
export default function TextEditLayer({
  pageNum,
  textItems,
  textEdits,
  onEdit,
  scale,
  pageHeight,
  viewportHeight,
}) {
  const [activeItemId, setActiveItemId] = useState(null)
  const inputRef = useRef(null)

  // Focus input when an item becomes active
  useEffect(() => {
    if (activeItemId !== null && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [activeItemId])

  // Click outside to deselect
  const handleLayerClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      setActiveItemId(null)
    }
  }, [])

  const getEditedText = (item) => {
    const key = `${pageNum}-${item.id}`
    return key in textEdits ? textEdits[key] : item.str
  }

  const isEdited = (item) => {
    const key = `${pageNum}-${item.id}`
    return key in textEdits && textEdits[key] !== item.originalStr
  }

  return (
    <div
      className="text-edit-layer"
      onClick={handleLayerClick}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: viewportHeight,
        pointerEvents: 'auto',
        zIndex: 5,
      }}
    >
      {textItems.map((item) => {
        // Convert PDF coordinates (origin bottom-left) to screen coordinates (origin top-left)
        const screenX = item.x * scale
        // PDF y is distance from bottom of page to the text baseline
        const screenY = viewportHeight - (item.y * scale) - (item.height * scale)
        const screenW = Math.max(item.width * scale, 20)
        const screenH = Math.max(item.height * scale, 14)
        const currentText = getEditedText(item)
        const edited = isEdited(item)
        const isActive = activeItemId === item.id

        return (
          <div
            key={item.id}
            className={`text-edit-item ${edited ? 'text-edit-item-edited' : ''} ${isActive ? 'text-edit-item-active' : ''}`}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              minWidth: screenW,
              height: screenH,
              cursor: 'text',
            }}
            onClick={(e) => {
              e.stopPropagation()
              setActiveItemId(item.id)
            }}
          >
            {isActive ? (
              <input
                ref={inputRef}
                className="text-edit-input"
                type="text"
                value={currentText}
                onChange={(e) => onEdit(pageNum, item.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    setActiveItemId(null)
                  }
                }}
                onBlur={() => {
                  // Small delay so click on another item registers first
                  setTimeout(() => setActiveItemId(null), 150)
                }}
                style={{
                  fontSize: item.fontSize * scale,
                  height: screenH + 4,
                  minWidth: screenW,
                }}
              />
            ) : (
              <span
                className="text-edit-label"
                style={{
                  fontSize: item.fontSize * scale * 0.9,
                  lineHeight: `${screenH}px`,
                }}
                title={edited ? `Original: "${item.originalStr}"` : 'Click to edit'}
              >
                {/* Invisible text just for sizing — the real text shows through the PDF canvas */}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
