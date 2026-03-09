import { useState, useRef, useCallback } from 'react'

export default function UploadArea({ onFileLoad }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  const handleFile = useCallback((file) => {
    if (!file || file.type !== 'application/pdf') {
      alert('Please select a valid PDF file.')
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      onFileLoad(e.target.result, file.name)
    }
    reader.readAsArrayBuffer(file)
  }, [onFileLoad])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    handleFile(file)
  }, [handleFile])

  const onDragOver = useCallback((e) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  const onDragLeave = useCallback(() => {
    setDragging(false)
  }, [])

  return (
    <div className="upload-area">
      <div
        className={`upload-box ${dragging ? 'dragging' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
      >
        <div className="upload-icon">📁</div>
        <h2>Open a PDF to edit</h2>
        <p>Drag and drop your PDF here, or click to browse</p>
        <button className="upload-btn" onClick={(e) => e.stopPropagation()}>
          Choose PDF
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files[0]) handleFile(e.target.files[0])
          }}
        />
      </div>
    </div>
  )
}
