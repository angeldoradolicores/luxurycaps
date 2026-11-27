'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ShoppingBag, Heart, Eye } from 'lucide-react'
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

// Una sola etiqueta funcional, con acabado negro perlado.
function MetalBadge({ text }: { text: string }) {
  return (
    <span className="inline-block rounded-sm px-2 py-1 text-[10px] sm:text-xs font-semibold tracking-wide text-slate-100 border border-white/20 shadow-md"
      style={{ background: 'linear-gradient(135deg, #34373d 0%, #17191d 46%, #08090b 100%)' }}>
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
            background: 'radial-gradient(ellipse at 12% 0%, rgba(181,191,207,0.14), transparent 55%), linear-gradient(145deg, #202226 0%, #101114 46%, #08090b 100%)',
            border: isHovered ? '1px solid rgba(210,219,233,0.38)' : '1px solid rgba(184,194,210,0.18)',
            borderRadius: '12px',
            boxShadow: isHovered
              ? 'inset 0 1px 0 rgba(255,255,255,0.12), 0 20px 48px rgba(0,0,0,0.55)'
              : 'inset 0 1px 0 rgba(255,255,255,0.07), 0 8px 24px rgba(0,0,0,0.35)',
            transform: isHovered ? 'translateY(-6px)' : 'translateY(0)',
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Image Container */}
            <div className="relative aspect-square overflow-hidden" style={{ background: 'linear-gradient(135deg, #292c32, #111215 65%, #08090b)' }}>
            <Image
              src={(product.images || []).find(Boolean) || '/images/placeholder-hat.jpg'}
              alt={product.name}
              fill
              sizes="(max-width: 767px) 50vw, (max-width: 1023px) 34vw, 25vw"
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


            {/* Reflejo satinado superior */}
            <div
              className="absolute top-0 left-0 right-0"
              style={{
                height: '40%',
                background: 'linear-gradient(to bottom, rgba(255,255,255,0.03) 0%, transparent 100%)',
                pointerEvents: 'none',
              }}
            />

            {/* Disponibilidad o descuento, sin etiquetas repetidas */}
            <div className="absolute top-2 left-2 sm:top-3 sm:left-3">
              {product.stock === 0 ? (
                <MetalBadge text="Agotado" />
              ) : product.is_promotion && discount > 0 ? (
                <MetalBadge text={`-${discount}%`} />
              ) : null}
            </div>

            {/* Quick Actions (derecha) */}
            <div
              className="absolute top-3 right-3 hidden sm:flex flex-col gap-2 transition-all duration-300"
              style={{ opacity: isHovered ? 1 : 0, transform: isHovered ? 'translateX(0)' : 'translateX(8px)' }}
            >
              <button
                onClick={handleWishlist}
                aria-label={isWishlisted ? 'Quitar de favoritos' : 'Agregar a favoritos'}
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
                aria-label="Ver producto"
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
              className="sm:hidden absolute top-1.5 right-1.5 w-9 h-9 flex items-center justify-center rounded-full"
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
                className="sm:hidden absolute bottom-1.5 right-1.5 w-10 h-10 flex items-center justify-center rounded-full active:scale-95 transition-transform"
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

          {/* Content */}
          <div className="p-3 pb-4 sm:p-4 sm:pb-5">
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
                className="text-[10px] tracking-[0.12em] sm:text-xs sm:tracking-[0.2em] font-semibold uppercase block truncate sm:mb-2"
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
              className="font-semibold text-sm leading-snug sm:text-sm sm:leading-snug mb-1 sm:mb-3 line-clamp-2 break-words transition-colors duration-300"
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
                className="text-base sm:text-base font-bold leading-tight"
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
                  className="text-xs sm:text-xs line-through leading-tight"
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
                ? 'linear-gradient(to right, transparent, rgba(207,218,235,0.5), transparent)'
                : 'linear-gradient(to right, transparent, rgba(137,149,168,0.2), transparent)',
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

/** Grilla de productos: 2 por fila en celular, 3 en tablet y 4 en escritorio */
export const PRODUCT_GRID = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-6'

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
