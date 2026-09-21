import { useRef, useState } from 'react'
import { ImagePlus, Trash2, Upload } from 'lucide-react'
import { Spinner } from './ui'
import { prepareImage } from '../lib/image'

// Resize the selected cover image before passing it to the event form.
export default function ImagePicker({ preview, onChange }) {
  const input = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const take = async (file) => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const blob = await prepareImage(file)
      onChange(blob, URL.createObjectURL(blob))
    } catch (err) {
      setError(err.message || 'That image couldn’t be used.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const drop = (e) => {
    e.preventDefault()
    setDragging(false)
    take(e.dataTransfer.files?.[0])
  }

  return (
    <div className="image-picker">
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => take(e.target.files?.[0])}
      />

      {preview ? (
        <div className="image-preview">
          <img src={preview} alt="Cover image preview" />
          <div className="image-preview-actions">
            <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={busy}>
              {busy ? <Spinner /> : <Upload />} Replace
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => onChange(null, null)} disabled={busy}>
              <Trash2 /> Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`image-drop ${dragging ? 'is-dragging' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          disabled={busy}
        >
          {busy ? <Spinner className="loader" /> : <ImagePlus />}
          <strong>{busy ? 'Preparing the image…' : 'Add a cover image'}</strong>
          <span>Drag a photo here, or click to choose one</span>
        </button>
      )}

      {error && <span className="field-hint danger">{error}</span>}
      <span className="field-hint">
        Shown behind the date on the event card, so a wide photo works best. Large photos are
        resized automatically.
      </span>
    </div>
  )
}
