'use client'
// A route whose page reads its query string (useSearchParams): the static export needs it under Suspense, so every
// such route renders its view through this. `params` hands the view what it reads, as plain strings.
import { Suspense, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageLoading } from './PageLoading'

function WithParams({ render }: { render: (q: URLSearchParams) => ReactNode }) {
  const q = useSearchParams()
  return <>{render(new URLSearchParams(q.toString()))}</>
}

export function RoutePage({ render }: { render: (q: URLSearchParams) => ReactNode }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <WithParams render={render} />
    </Suspense>
  )
}
