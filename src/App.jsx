import { useState, useCallback } from 'react'
import './App.css'
import UploadArea from './components/UploadArea'
import PdfEditor from './components/PdfEditor'

function App() {
  const [pdfData, setPdfData] = useState(null)
  const [fileName, setFileName] = useState('')

  const handleFileLoad = useCallback((arrayBuffer, name) => {
    setPdfData(arrayBuffer)
    setFileName(name)
  }, [])

  const handleClose = useCallback(() => {
    setPdfData(null)
    setFileName('')
  }, [])

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="header-logo">📄</span>
          <h1>PDF Editor</h1>
        </div>
        <div className="header-right">
          {fileName && <span className="file-name">{fileName}</span>}
          {pdfData && (
            <button className="btn btn-secondary" onClick={handleClose}>
              ✕ Close
            </button>
          )}
        </div>
      </header>

      {!pdfData ? (
        <UploadArea onFileLoad={handleFileLoad} />
      ) : (
        <PdfEditor pdfData={pdfData} fileName={fileName} />
      )}
    </div>
  )
}

export default App
