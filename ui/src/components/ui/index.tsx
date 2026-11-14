// Small building blocks shared by every page. Restyle them in styles/ui.css.
import { useState, type ReactNode } from 'react'
import Link from 'next/link'

type ButtonProps = {
  children: ReactNode
  to?: string // makes it a link
  href?: string // external link
  onClick?: () => void
  variant?: 'primary' | 'ghost'
  disabled?: boolean
  type?: 'button' | 'submit'
}

export function Button({ children, to, href, onClick, variant = 'primary', disabled, type = 'button' }: ButtonProps) {
  const cls = `btn btn--${variant}`
  if (to) return <Link className={cls} href={to}>{children}</Link>
  if (href) return <a className={cls} href={href} target="_blank" rel="noreferrer">{children}</a>
  return <button className={cls} type={type} onClick={onClick} disabled={disabled}>{children}</button>
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value num">{value}</span>
    </div>
  )
}

export function Tag({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'accent' | 'muted' }) {
  return <span className={`tag tag--${tone}`}>{children}</span>
}

export function Section({ id, eyebrow, title, children, intro }: { id?: string; eyebrow?: string; title: string; intro?: string; children?: ReactNode }) {
  return (
    <section className="section" id={id}>
      {eyebrow && <p className="section__eyebrow">{eyebrow}</p>}
      <h2 className="section__title">{title}</h2>
      {intro && <p className="section__intro">{intro}</p>}
      {children && <div className="section__body">{children}</div>}
    </section>
  )
}

// Marks a part of the layout that still needs real design or content.
export function Placeholder({ label, height = 160 }: { label: string; height?: number }) {
  return (
    <div className="placeholder" style={{ minHeight: height }}>
      <span>{label}</span>
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={t.id === value} className={`tabs__tab${t.id === value ? ' is-active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

// Questions that open and close. Works without JavaScript.
export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="faq">
      {items.map((it) => (
        <details key={it.q} className="faq__item">
          <summary className="faq__q">{it.q}</summary>
          <div className="faq__a">{it.a}</div>
        </details>
      ))}
    </div>
  )
}

export function AmountInput({ label, onSubmit, cta, disabled }: { label: string; cta: string; onSubmit: (amount: number) => void; disabled?: boolean }) {
  const [value, setValue] = useState('')
  const amount = Number(value)
  return (
    <form
      className="amount"
      onSubmit={(e) => {
        e.preventDefault()
        if (amount > 0) onSubmit(amount)
      }}
    >
      <label className="amount__label">
        {label}
        <span className="amount__field">
          <input inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))} />
          <span className="amount__unit">USDC</span>
        </span>
      </label>
      <Button type="submit" disabled={disabled || !(amount > 0)}>{cta}</Button>
    </form>
  )
}
