import { Button } from '../components/ui'

export default function NotFound() {
  return (
    <div className="page" style={{ textAlign: 'center', paddingTop: 120 }}>
      <h1 className="page__title">Nothing here</h1>
      <p className="page__sub">The link may be old or mistyped.</p>
      <div style={{ marginTop: 24 }}><Button to="/">Back home</Button></div>
    </div>
  )
}
