// Scroll reveal: sections, cards and panels drift up gently the first time they come into view.
// Runs again on every route change. With reduced motion, everything is simply shown.
import { useEffect } from 'react'

const TARGETS = [
  '.landing-intro', '.world-demo', '.landing-markets', '.landing-faq', '.landing-close',
  '.docs__section', '.slip', '.sc__panel', '.sc__position', '.sc__ticket', '.pf-scenario', '.tally', '.pgroup',
  '.panel', '.drawer .file', '.market-index > a',
].join(',')

export function useReveal(key: string) {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(TARGETS))
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
    // a small stagger for siblings of the same kind (cards in a grid, rows in a list)
    els.forEach((el) => {
      const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.matches(TARGETS)) : []
      el.style.setProperty('--reveal-delay', `${Math.min(siblings.indexOf(el), 6) * 60}ms`)
      el.dataset.reveal = ''
    })
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return
        e.target.classList.add('is-in')
        io.unobserve(e.target)
      }),
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [key])
}
