'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export interface CategoryOption {
  slug: string
  label: string
}

interface CategoryScrollerProps {
  options: CategoryOption[]
  selected: string
  onSelect: (slug: string) => void
}

/**
 * Barra horizontal de categorías para escritorio: se arrastra con el mouse (con inercia),
 * se desplaza con trackpad/rueda horizontal y con flechas, y centra la categoría activa.
 */
export function CategoryScroller({ options, selected, onSelect }: CategoryScrollerProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef({ active: false, moved: false, startX: 0, startLeft: 0, lastX: 0, lastT: 0, velocity: 0 })
  const momentum = useRef<number | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const [dragging, setDragging] = useState(false)

  const updateEdges = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setEdges({
      left: el.scrollLeft > 4,
      right: el.scrollLeft < el.scrollWidth - el.clientWidth - 4,
    })
  }, [])

  const stopMomentum = () => {
    if (momentum.current !== null) cancelAnimationFrame(momentum.current)
    momentum.current = null
  }

  useEffect(() => {
    updateEdges()
    window.addEventListener('resize', updateEdges)
    return () => {
      window.removeEventListener('resize', updateEdges)
      stopMomentum()
    }
  }, [options.length, updateEdges])

  // Mantiene visible (y centrada) la categoría activa, también al llegar con ?category=
  useEffect(() => {
    const el = scroller.current
    const button = el?.querySelector<HTMLElement>('[data-active="true"]')
    if (!el || !button) return
    const target = button.offsetLeft - (el.clientWidth - button.offsetWidth) / 2
    el.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
  }, [selected, options.length])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    stopMomentum()
    const el = scroller.current!
    drag.current = { active: true, moved: false, startX: e.clientX, startLeft: el.scrollLeft, lastX: e.clientX, lastT: e.timeStamp, velocity: 0 }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d.active) return
    const el = scroller.current!
    const dx = e.clientX - d.startX
    if (!d.moved && Math.abs(dx) > 5) {
      d.moved = true
      setDragging(true)
      el.setPointerCapture(e.pointerId)
    }
    if (!d.moved) return
    el.scrollLeft = d.startLeft - dx
    const dt = Math.max(1, e.timeStamp - d.lastT)
    d.velocity = (d.lastX - e.clientX) / dt // px por ms
    d.lastX = e.clientX
    d.lastT = e.timeStamp
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d.active) return
    d.active = false
    setDragging(false)
    if (el_has_capture(scroller.current, e.pointerId)) scroller.current!.releasePointerCapture(e.pointerId)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!d.moved || reduce || Math.abs(d.velocity) < 0.05) return
    // Inercia: la velocidad decae suavemente hasta detenerse
    let v = d.velocity * 16
    const step = () => {
      const el = scroller.current
      if (!el) return
      el.scrollLeft += v
      v *= 0.94
      momentum.current = Math.abs(v) > 0.4 ? requestAnimationFrame(step) : null
    }
    momentum.current = requestAnimationFrame(step)
  }

  const nudge = (direction: 1 | -1) => {
    stopMomentum()
    const el = scroller.current
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.7, behavior: 'smooth' })
  }

  const mask =
    `linear-gradient(to right, ${edges.left ? 'transparent 0, #000 64px' : '#000 0'}, ` +
    `${edges.right ? '#000 calc(100% - 64px), transparent 100%' : '#000 100%'})`

  return (
    <div className="relative">
      {edges.left && (
        <button
          type="button"
          aria-label="Ver categorías anteriores"
          onClick={() => nudge(-1)}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 h-8 w-8 flex items-center justify-center border border-steel/30 bg-carbon/80 text-chrome backdrop-blur hover:border-gold-action hover:text-gold-action transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      <div
        ref={scroller}
        onScroll={updateEdges}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // Si hubo arrastre, el clic final no debe seleccionar una categoría por accidente
        onClickCapture={(e) => {
          if (drag.current.moved) {
            e.preventDefault()
            e.stopPropagation()
            drag.current.moved = false
          }
        }}
        className={`flex gap-8 items-center overflow-x-auto px-12 select-none [&::-webkit-scrollbar]:hidden ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ scrollbarWidth: 'none', maskImage: mask, WebkitMaskImage: mask }}
      >
        {options.map(({ slug, label }, index) => {
          const isActive = selected === slug
          return (
            <motion.button
              key={slug}
              type="button"
              data-active={isActive}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(index, 12) * 0.04, duration: 0.5, ease: 'easeOut' }}
              onClick={() => onSelect(slug)}
              className="relative shrink-0 whitespace-nowrap py-2 text-xs uppercase tracking-[0.2em] font-sans font-semibold transition-colors duration-300 focus:outline-none"
              style={{ color: isActive ? '#DDE8F5' : '#8B8B8B' }}
            >
              <span className="hover:text-white-diamond transition-colors duration-200">{label}</span>
              {isActive && (
                <motion.div
                  layoutId="activeCategoryUnderline"
                  className="absolute bottom-0 left-0 right-0 h-[2px] bg-gold-action"
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}
            </motion.button>
          )
        })}
      </div>
      {edges.right && (
        <button
          type="button"
          aria-label="Ver más categorías"
          onClick={() => nudge(1)}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 h-8 w-8 flex items-center justify-center border border-steel/30 bg-carbon/80 text-chrome backdrop-blur hover:border-gold-action hover:text-gold-action transition-colors cursor-pointer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

function el_has_capture(el: HTMLElement | null, pointerId: number) {
  return !!el && el.hasPointerCapture(pointerId)
}
