/**
 * Pure visual helper for mapping per-particle physical properties
 * (radius, brightness) to sprite tier and draw size without runtime allocations.
 */

import { Particle } from '../physics/types.ts';

export const SPRITE_BASE_PX = 12;
export const DEFAULT_PARTICLE_RADIUS = 1.15;
export const MIN_BRIGHTNESS = 0.82;
export const MAX_BRIGHTNESS = 1.18;

export interface ParticleRenderParams {
  spriteTier: number;
  drawSize: number;
}

/**
 * Computes per-particle sprite tier (from brightness) and scaled draw size (from radius).
 */
export function computeParticleRenderParams(
  particle: Pick<Particle, 'radius' | 'brightness'>,
  tierCount: number
): ParticleRenderParams {
  const safeTiers = Math.max(1, tierCount);
  const b = particle.brightness ?? 1.0;
  const normB = Math.max(
    0,
    Math.min(0.9999, (b - MIN_BRIGHTNESS) / (MAX_BRIGHTNESS - MIN_BRIGHTNESS))
  );
  const spriteTier = Math.floor(normB * safeTiers);

  const r = particle.radius ?? DEFAULT_PARTICLE_RADIUS;
  const clampedR = Math.max(0.6, Math.min(2.0, r));
  const drawSize = SPRITE_BASE_PX * (clampedR / DEFAULT_PARTICLE_RADIUS);

  return { spriteTier, drawSize };
}
