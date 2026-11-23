'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ShoppingBag, Heart, Eye } from 'lucide-react'
import SparklesUI from './sparkles'
import { useCartStore, useFavoritesStore } from '@/lib/store'
import { toast } from 'sonner'
import { useState } from 'react'

export interface Product {
  id: string
  name: string
  slug?: string
  description: string
  price: number
  original_price?: number | null
  category: string
  category_slug?: string
  stock: number
  featured: boolean
  is_promotion?: boolean
  images: string[]
  videos?: string[]
  colors: string[]
  sizes: string[]
  created_at?: string
}

interface ProductCardProps {
  product: Product
  index?: number
}

function formatPrice(price: number) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
  }).format(price)
}

// Badge metálico
function MetalBadge({ text, variant = 'gold' }: { text: string; variant?: 'gold' | 'chrome' | 'crimson' }) {
  const styles = {
    gold: {
      background: 'linear-gradient(135deg, rgba(221,232,245,0.18), rgba(201,205,210,0.12))',
      border: '1px solid rgba(221,232,245,0.25)',
      color: '#DDE8F5',
    },
    chrome: {
      background: 'linear-gradient(135deg, rgba(192,192,192,0.1), rgba(139,139,139,0.08))',
      border: '1px solid rgba(192,192,192,0.3)',
      color: '#C0C0C0',
    },
    crimson: {
      background: 'linear-gradient(135deg, rgba(180,30,30,0.15), rgba(150,20,20,0.1))',
      border: '1px solid rgba(200,50,50,0.4)',
      color: '#F87171',
    },
  }
  return (
    <span
      className="inline-block px-1.5 py-0.5 text-[7px] tracking-[0.08em] sm:px-2.5 sm:py-1 sm:text-[9px] sm:tracking-[0.18em] font-bold uppercase whitespace-nowrap"
      style={{
        fontFamily: 'var(--font-sans)',
        ...styles[variant],
      }}
    >
      {text}
    </span>
  )
}

export function ProductCard({ product, index = 0 }: ProductCardProps) {
  const addItem = useCartStore(state => state.addItem)
  const toggleFavorite = useFavoritesStore(state => state.toggleFavorite)
  const router = useRouter()
  const isWishlisted = useFavoritesStore(state => state.items.some(i => i.id === product.id))
  const [isHovered, setIsHovered] = useState(false)

  const discount = product.original_price
    ? Math.round((1 - product.price / product.original_price) * 100)
    : 0

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    addItem(product as any, product.colors?.[0] || '', product.sizes?.[0] || '', 1)
    toast.success('Agregado al carrito', { description: product.name })
  }

  const handleWishlist = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const wasWishlisted = isWishlisted
    await toggleFavorite(product as any)
    if (!wasWishlisted) {
      toast.success('Agregado a favoritos')
    } else {
      toast.info('Eliminado de favoritos')
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileHover={{ rotateX: 3, rotateY: -3, scale: 1.01 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: index * 0.08, ease: [0.22, 1, 0.36, 1] }}
      className="group"
      style={{ transformStyle: 'preserve-3d' }}
    >
      <div
        role="link"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            router.push(`/producto/${product.slug || product.id}`)
          }
        }}
        onClick={() => router.push(`/producto/${product.slug || product.id}`)}
      >
        <div
          className="relative overflow-hidden transition-all duration-500"
          style={{
            background: '#0D0D0D',
            border: product.featured || product.is_promotion ? '1px solid rgba(200,164,77,0.35)' : (isHovered ? '1px solid rgba(192,192,192,0.25)' : '1px solid #262626'),
            boxShadow: product.featured || product.is_promotion
              ? '0 28px 68px rgba(200,164,77,0.06), 0 6px 20px rgba(0,0,0,0.6)'
              : isHovered
              ? '0 20px 48px rgba(0,0,0,0.75), 0 0 0 1px rgba(221,232,245,0.1)'
              : '0 4px 16px rgba(0,0,0,0.4)',
            transform: isHovered ? 'translateY(-6px)' : 'translateY(0)',
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Image Container */}
            <div className="relative aspect-square overflow-hidden" style={{ background: '#171717' }}>
            <Image
              src={(product.images || []).find(Boolean) || '/images/placeholder-hat.jpg'}
              alt={product.name}
              fill
              sizes="(max-width: 1024px) 34vw, 25vw"
              className="object-cover transition-transform duration-700"
              style={{
                transform: isHovered ? 'scale(1.07)' : 'scale(1)',
              }}
              loading="lazy"
            />

            {/* Overlay gradiente al hover */}
            <div
              className="absolute inset-0 transition-opacity duration-500"
              style={{
                background: 'linear-gradient(to top, rgba(5,5,5,0.85) 0%, rgba(5,5,5,0.2) 40%, transparent 70%)',
                opacity: isHovered ? 1 : 0,
              }}
            />

            {/* Sparkles + shimmer overlay */}
            <SparklesUI extra={isHovered ? 2 : 0} />
            <div className="reflect-shimmer" />

            {/* Reflejo satinado superior */}
            <div
              className="absolute top-0 left-0 right-0"
              style={{
                height: '40%',
                background: 'linear-gradient(to bottom, rgba(255,255,255,0.03) 0%, transparent 100%)',
                pointerEvents: 'none',
              }}
            />

            {/* Badges */}
            {/* En móvil sólo la primera etiqueta (las demás se ocultan con [&>*:nth-child(n+2)]) */}
            <div className="absolute top-1.5 left-1.5 sm:top-3 sm:left-3 flex flex-col items-start gap-1 sm:gap-1.5 [&>*:nth-child(n+2)]:hidden sm:[&>*:nth-child(n+2)]:inline-block">
              {product.stock === 0 && (
                <MetalBadge text="Agotado" variant="chrome" />
              )}
              {product.is_promotion && discount > 0 && (
                <MetalBadge text={`-${discount}%`} variant="crimson" />
              )}
              {product.featured && product.stock > 0 && (
                <MetalBadge text="Exclusivo" variant="gold" />
              )}
              {product.stock > 0 && product.stock < 5 && (
                <MetalBadge text={`Últimas ${product.stock}`} variant="crimson" />
              )}
            </div>

            {/* Quick Actions (derecha) */}
            <div
              className="absolute top-3 right-3 hidden sm:flex flex-col gap-2 transition-all duration-300"
              style={{ opacity: isHovered ? 1 : 0, transform: isHovered ? 'translateX(0)' : 'translateX(8px)' }}
            >
              <button
                onClick={handleWishlist}
                className="w-9 h-9 flex items-center justify-center transition-all duration-200"
                style={{
                  background: 'rgba(13,13,13,0.85)',
                  backdropFilter: 'blur(8px)',
                  border: isWishlisted ? '1px solid rgba(221,232,245,0.25)' : '1px solid #333',
                  color: isWishlisted ? '#DDE8F5' : '#8B8B8B',
                }}
              >
                <Heart className="w-4 h-4" style={{ fill: isWishlisted ? 'currentColor' : 'none' }} />
              </button>
              <button
                className="w-9 h-9 flex items-center justify-center transition-all duration-200"
                style={{
                  background: 'rgba(13,13,13,0.85)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid #333',
                  color: '#8B8B8B',
                }}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  window.location.href = `/producto/${product.slug || product.id}`
                }}
              >
                <Eye className="w-4 h-4" />
              </button>
            </div>

            {/* Móvil / táctil: botones siempre visibles (no existe el hover) */}
            <button
              onClick={handleWishlist}
              aria-label={isWishlisted ? 'Quitar de favoritos' : 'Agregar a favoritos'}
              className="sm:hidden absolute top-1.5 right-1.5 w-7 h-7 flex items-center justify-center rounded-full"
              style={{
                background: 'rgba(13,13,13,0.75)',
                border: isWishlisted ? '1px solid rgba(221,232,245,0.35)' : '1px solid #333',
                color: isWishlisted ? '#DDE8F5' : '#C0C0C0',
              }}
            >
              <Heart className="w-3.5 h-3.5" style={{ fill: isWishlisted ? 'currentColor' : 'none' }} />
            </button>
            {product.stock > 0 && (
              <button
                onClick={handleAddToCart}
                aria-label="Agregar al carrito"
                className="sm:hidden absolute bottom-1.5 right-1.5 w-8 h-8 flex items-center justify-center rounded-full active:scale-95 transition-transform"
                style={{
                  background: 'linear-gradient(135deg, #C9CDD2 0%, #DDE8F5 100%)',
                  color: '#050505',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                }}
              >
                <ShoppingBag className="w-4 h-4" />
              </button>
            )}

            {/* Add to Cart (bottom, aparece en hover — escritorio) */}
            <div
              className="absolute bottom-0 left-0 right-0 hidden sm:block transition-all duration-400"
              style={{
                opacity: isHovered ? 1 : 0,
                transform: isHovered ? 'translateY(0)' : 'translateY(12px)',
              }}
            >
              <button
                onClick={handleAddToCart}
                disabled={product.stock === 0}
                className="w-full py-3.5 flex items-center justify-center gap-2.5 text-[10px] font-bold uppercase transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  fontFamily: 'var(--font-sans)',
                  letterSpacing: '0.2em',
                  background: product.stock === 0
                    ? 'rgba(38,38,38,0.95)'
                    : 'linear-gradient(135deg, #C9CDD2 0%, #DDE8F5 100%)',
                  color: product.stock === 0 ? '#8B8B8B' : '#050505',
                  backdropFilter: 'blur(8px)',
                }}
              >
                <ShoppingBag className="w-3.5 h-3.5" />
                {product.stock === 0 ? 'Agotado' : 'Agregar al Carrito'}
              </button>
            </div>
          </div>

          {/* Ribbon for featured/promotion (top-right) */}
          {(product.featured || product.is_promotion) && (
            <div className="absolute top-3 right-0 pointer-events-none hidden sm:block" style={{ transform: 'translate(18px, -8px) rotate(12deg)' }}>
              <div style={{ padding: '6px 14px', background: product.featured ? 'linear-gradient(90deg,#C9A84D,#FFD36A)' : 'linear-gradient(90deg,#F87171,#FB7185)', color: '#050505', fontWeight: 700, fontSize: '11px', borderRadius: '6px', boxShadow: '0 6px 20px rgba(0,0,0,0.4)' }}>
                {product.featured ? 'EXCLUSIVO' : 'OFERTA'}
              </div>
            </div>
          )}

          {/* Content */}
          <div className="p-2 pb-2.5 sm:p-4 sm:pb-5">
            {/* Category */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                router.push(`/catalogo?category=${encodeURIComponent(product.category_slug || product.category)}`)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  router.push(`/catalogo?category=${encodeURIComponent(product.category_slug || product.category)}`)
                }
              }}
              className="block max-w-full mb-0.5 sm:mb-2"
              style={{ cursor: 'pointer' }}
            >
              <span
                className="text-[7px] tracking-[0.12em] sm:text-[9px] sm:tracking-[0.3em] font-semibold uppercase block truncate sm:mb-2"
                style={{
                  fontFamily: 'var(--font-sans)',
                  color: '#8B8B8B',
                }}
              >
                {product.category}
              </span>
            </span>

            {/* Name */}
            <h3
              className="font-semibold text-[10px] leading-tight sm:text-sm sm:leading-snug mb-1 sm:mb-3 line-clamp-2 break-words transition-colors duration-300"
              style={{
                fontFamily: 'var(--font-cinzel)',
                color: isHovered ? '#F5F5F5' : '#C0C0C0',
                letterSpacing: '0.02em',
              }}
            >
              {product.name}
            </h3>

            {/* Colors */}
            {product.colors?.length > 0 && (
              <div className="hidden sm:flex items-center gap-1.5 mb-3">
                {product.colors.slice(0, 5).map((color, i) => (
                  <span
                    key={i}
                    className="w-3 h-3 rounded-full"
                    style={{
                      backgroundColor: getColorHex(color),
                      border: '1px solid rgba(255,255,255,0.15)',
                    }}
                    title={color}
                  />
                ))}
                {product.colors?.length > 5 && (
                  <span className="text-[10px]" style={{ color: '#8B8B8B' }}>
                    +{product.colors.length - 5}
                  </span>
                )}
              </div>
            )}

            {/* Price */}
            <div className="flex flex-col sm:flex-row sm:items-baseline gap-0 sm:gap-2.5">
              <span
                className="text-[11px] sm:text-base font-bold leading-tight"
                style={{
                  fontFamily: 'var(--font-cinzel)',
                  background: 'linear-gradient(135deg, #C9CDD2, #DDE8F5)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                {formatPrice(product.price)}
              </span>
              {product.original_price && product.original_price > product.price && (
                <span
                  className="text-[9px] sm:text-xs line-through leading-tight"
                  style={{ color: '#666' }}
                >
                  {formatPrice(product.original_price)}
                </span>
              )}
            </div>
          </div>

          {/* Bottom separator / highlight bar */}
          <div
            className="absolute bottom-0 left-0 right-0 h-px transition-all duration-500"
            style={{
              background: isHovered
                ? 'linear-gradient(to right, transparent, rgba(200,164,77,0.5), transparent)'
                : 'linear-gradient(to right, transparent, rgba(38,38,38,0.8), transparent)',
            }}
          />
            </div>
          </div>
          </motion.div>
  )
}

function getColorHex(colorName: string): string {
  const colorMap: Record<string, string> = {
    'Negro': '#1a1a1a',
    'Blanco': '#f5f5f5',
    'Rojo': '#991b1b',
    'Azul': '#1e3a5f',
    'Verde': '#14532d',
    'Amarillo': '#ca8a04',
    'Naranja': '#c2410c',
    'Morado': '#581c87',
    'Rosa': '#9d174d',
    'Gris': '#6b7280',
    'Cafe': '#78350f',
    'Beige': '#d4a574',
    'Celeste': '#164e63',
    'Navy': '#1e3a5f',
    'Vinotinto': '#7c2d12',
    'Dorado': '#b08d57',
    'Plateado': '#8b8b8b',
  }
  return colorMap[colorName] || '#4b5563'
}

/** Grilla de productos: 3 por fila en celular y tablet, 4 en escritorio */
export const PRODUCT_GRID = 'grid grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-4 lg:gap-6'

interface ProductGridProps {
  products: Product[]
  className?: string
}

export function ProductGrid({ products, className = '' }: ProductGridProps) {
  return (
    <div className={`${PRODUCT_GRID} ${className}`}>
      {products.map((product, index) => (
        <ProductCard key={product.id} product={product} index={index} />
      ))}
    </div>
  )
}
