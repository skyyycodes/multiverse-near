// What a page shows while its query string and first chain reads arrive (the Suspense fallback of every route that
// reads ?id=, ?p= or ?w=). The static export ships it as the page's HTML.
export function PageLoading({ label = 'Reading the chain…' }: { label?: string }) {
  return (
    <div className="page tr desk">
      <div className="tr__panel desk__empty" role="status" aria-live="polite"><p>{label}</p></div>
    </div>
  )
}
