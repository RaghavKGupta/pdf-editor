import { useState, useRef, useEffect, useCallback } from 'react'

const FONTS = [
  { name: 'Cursive', family: 'cursive' },
  { name: 'Serif', family: 'Georgia, serif' },
  { name: 'Script', family: "'Brush Script MT', cursive" },
  { name: 'Mono', family: "'Courier New', monospace" },
]

export default function SignatureModal({ onSave, onClose }) {
  const [tab, setTab] = useState('draw') // 'draw' | 'type'
  const [typedText, setTypedText] = useState('')
  const [selectedFont, setSelectedFont] = useState(0)
  const canvasRef = useRef(null)
  const isDrawing = useRef(false)
  const lastPoint = useRef(null)

  useEffect(() => {
    if (tab === 'draw' && canvasRef.current) {
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')
      canvas.width = canvas.offsetWidth * 2
      canvas.height = 200
      ctx.scale(2, 2)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = '#1a1a2e'
      ctx.lineWidth = 2.5
    }
  }, [tab])

  const getPoint = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const scaleX = (canvas.width / 2) / rect.width
    const scaleY = (canvas.height / 2) / rect.height
    if (e.touches) {
      return {
        x: (e.touches[0].clientX - rect.left) * scaleX,
        y: (e.touches[0].clientY - rect.top) * scaleY,
      }
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const startDraw = (e) => {
    e.preventDefault()
    isDrawing.current = true
    lastPoint.current = getPoint(e)
  }

  const draw = (e) => {
    e.preventDefault()
    if (!isDrawing.current) return
    const ctx = canvasRef.current.getContext('2d')
    const point = getPoint(e)
    ctx.beginPath()
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
    lastPoint.current = point
  }

  const stopDraw = () => {
    isDrawing.current = false
    lastPoint.current = null
  }

  const clearCanvas = () => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const handleSave = useCallback(() => {
    if (tab === 'draw') {
      const canvas = canvasRef.current
      // Check if canvas is blank
      const ctx = canvas.getContext('2d')
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      const isEmpty = !data.some((val, i) => i % 4 === 3 && val > 0)
      if (isEmpty) return

      onSave(canvas.toDataURL('image/png'))
    } else {
      if (!typedText.trim()) return

      // Render typed signature to canvas
      const tmpCanvas = document.createElement('canvas')
      tmpCanvas.width = 400
      tmpCanvas.height = 100
      const ctx = tmpCanvas.getContext('2d')
      ctx.fillStyle = 'rgba(255,255,255,0)'
      ctx.clearRect(0, 0, 400, 100)
      ctx.font = `32px ${FONTS[selectedFont].family}`
      ctx.fillStyle = '#1a1a2e'
      ctx.textBaseline = 'middle'
      ctx.fillText(typedText, 10, 50)
      onSave(tmpCanvas.toDataURL('image/png'))
    }
  }, [tab, typedText, selectedFont, onSave])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Create Signature</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="signature-tabs">
            <button
              className={`signature-tab ${tab === 'draw' ? 'active' : ''}`}
              onClick={() => setTab('draw')}
            >
              Draw
            </button>
            <button
              className={`signature-tab ${tab === 'type' ? 'active' : ''}`}
              onClick={() => setTab('type')}
            >
              Type
            </button>
          </div>

          {tab === 'draw' ? (
            <>
              <canvas
                ref={canvasRef}
                className="signature-canvas"
                style={{ height: 100 }}
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={stopDraw}
                onMouseLeave={stopDraw}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={stopDraw}
              />
              <div style={{ marginTop: 8, textAlign: 'right' }}>
                <button className="btn btn-secondary" onClick={clearCanvas} style={{ fontSize: 12 }}>
                  Clear
                </button>
              </div>
            </>
          ) : (
            <>
              <input
                className="signature-type-input"
                type="text"
                placeholder="Type your signature"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                style={{ fontFamily: FONTS[selectedFont].family }}
                autoFocus
              />
              <div className="signature-font-select">
                {FONTS.map((font, i) => (
                  <button
                    key={font.name}
                    className={`font-option ${selectedFont === i ? 'active' : ''}`}
                    style={{ fontFamily: font.family }}
                    onClick={() => setSelectedFont(i)}
                  >
                    {typedText || font.name}
                  </button>
                ))}
              </div>
              {typedText && (
                <div className="signature-type-preview">
                  <span style={{
                    fontFamily: FONTS[selectedFont].family,
                    fontSize: 32,
                    color: '#1a1a2e',
                  }}>
                    {typedText}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>
            Use Signature
          </button>
        </div>
      </div>
    </div>
  )
}
