/**
 * The four glyphs of the capability strip: audio, photo, text and video, the
 * input modalities a model's facts report. DSH ships no glyph for any of them,
 * so each is drawn here as a tiny inline SVG (no dependency, no asset): plain
 * strokes in `currentColor`, sized 16px by default, and always `aria-hidden`,
 * because the strip puts the accessible name on the wrapper it renders.
 * @module dsh-orquestrator/client/facts-icons
 */

import type { JSX, ReactNode } from 'react'

/** Props of every glyph. */
export interface FactsIconProps {
  /** Side of the square glyph in pixels; defaults to 16. */
  readonly size?: number | undefined
}

/**
 * The shared frame: one 16-unit viewBox, stroke-only, decorative by contract.
 * @param props - the size and the paths of one glyph.
 * @returns the svg element.
 */
function Glyph({ size = 16, children }: { readonly size?: number | undefined; readonly children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * A microphone: the model can take audio in.
 * @param props - the glyph size.
 * @returns the svg element.
 */
export function FactsAudioIcon({ size }: FactsIconProps): JSX.Element {
  return (
    <Glyph size={size}>
      <rect x="6" y="1.8" width="4" height="7.2" rx="2" />
      <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0" />
      <path d="M8 11.8v2.4" />
      <path d="M5.6 14.2h4.8" />
    </Glyph>
  )
}

/**
 * A photo: a frame with a mountain and a sun, for image input.
 * @param props - the glyph size.
 * @returns the svg element.
 */
export function FactsPhotoIcon({ size }: FactsIconProps): JSX.Element {
  return (
    <Glyph size={size}>
      <rect x="1.8" y="3" width="12.4" height="10" rx="2" />
      <circle cx="10.3" cy="6.2" r="1.1" />
      <path d="M2.4 11.6l3.1-3.2 2.3 2.4" />
      <path d="M8.4 10.4l2-2.1 3.2 3.3" />
    </Glyph>
  )
}

/**
 * Three text lines: the model can take text in.
 * @param props - the glyph size.
 * @returns the svg element.
 */
export function FactsTextIcon({ size }: FactsIconProps): JSX.Element {
  return (
    <Glyph size={size}>
      <path d="M2.8 4.4h10.4" />
      <path d="M2.8 8h7.2" />
      <path d="M2.8 11.6h10.4" />
    </Glyph>
  )
}

/**
 * A play mark in a frame: the model can take video in.
 * @param props - the glyph size.
 * @returns the svg element.
 */
export function FactsVideoIcon({ size }: FactsIconProps): JSX.Element {
  return (
    <Glyph size={size}>
      <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2" />
      <path d="M6.6 6.4l3.6 1.6-3.6 1.6V6.4Z" fill="currentColor" stroke="none" />
    </Glyph>
  )
}
