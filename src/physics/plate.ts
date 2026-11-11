/**
 * Analytical Kirchhoff-Love Plate Theory for Square Simply Supported Plates
 */

import { PlateGeometry, PlateMaterial } from './types.ts';

export const DEFAULT_ALUMINUM: PlateMaterial = {
  name: 'Aluminum 6061-T6',
  youngsModulus: 69e9, // 69 GPa
  density: 2700,      // 2700 kg/m^3
  poissonRatio: 0.33,
};

export const DEFAULT_GEOMETRY: PlateGeometry = {
  sideLength: 0.30,   // 0.30 m
  thickness: 0.001,   // 0.001 m (1 mm)
};

/**
 * Calculates flexural rigidity D = (E * h^3) / [12 * (1 - nu^2)]
 * Units: N*m (or J)
 */
export function calculateFlexuralRigidity(material: PlateMaterial, geometry: PlateGeometry): number {
  const { youngsModulus: E, poissonRatio: nu } = material;
  const { thickness: h } = geometry;
  return (E * Math.pow(h, 3)) / (12 * (1 - nu * nu));
}

/**
 * Calculates analytical natural frequency f_mn for a simply supported square plate:
 * f_mn = (pi / 2 * L^2) * (m^2 + n^2) * sqrt(D / (rho * h))
 * Units: Hz
 */
export function calculateAnalyticalFrequency(
  m: number,
  n: number,
  material: PlateMaterial = DEFAULT_ALUMINUM,
  geometry: PlateGeometry = DEFAULT_GEOMETRY
): number {
  const D = calculateFlexuralRigidity(material, geometry);
  const { density: rho } = material;
  const { sideLength: L, thickness: h } = geometry;

  const prefactor = (Math.PI / (2 * L * L)) * Math.sqrt(D / (rho * h));
  return prefactor * (m * m + n * n);
}

/**
 * Calculates analytical angular natural frequency omega_mn = 2 * pi * f_mn
 * Units: rad/s
 */
export function calculateAnalyticalOmega(
  m: number,
  n: number,
  material: PlateMaterial = DEFAULT_ALUMINUM,
  geometry: PlateGeometry = DEFAULT_GEOMETRY
): number {
  return 2 * Math.PI * calculateAnalyticalFrequency(m, n, material, geometry);
}

/**
 * Calculates modal mass for mode (m, n):
 * M_mn = integral_0^L integral_0^L [rho * h * sin^2(m*pi*x/L) * sin^2(n*pi*y/L)] dx dy
 * For unnormalized sinusoidal modes, integral of sin^2 from 0 to L is L/2.
 * M_mn = rho * h * (L/2) * (L/2) = (rho * h * L^2) / 4
 * Units: kg
 */
export function calculateModalMass(
  material: PlateMaterial = DEFAULT_ALUMINUM,
  geometry: PlateGeometry = DEFAULT_GEOMETRY
): number {
  const { density: rho } = material;
  const { sideLength: L, thickness: h } = geometry;
  return (rho * h * L * L) / 4;
}

/**
 * Mode shape function phi_mn(x, y) = sin(m*pi*x/L) * sin(n*pi*y/L)
 * x, y in [0, L]
 */
export function modeShape(m: number, n: number, x: number, y: number, L: number = DEFAULT_GEOMETRY.sideLength): number {
  if (x < 0 || x > L || y < 0 || y > L) return 0;
  return Math.sin((m * Math.PI * x) / L) * Math.sin((n * Math.PI * y) / L);
}

/**
 * Generalized modal force for Point Force F(t) at (x0, y0):
 * Q_mn(t) = F(t) * phi_mn(x0, y0)
 */
export function pointForceModalCoupling(m: number, n: number, x0: number, y0: number, L: number = DEFAULT_GEOMETRY.sideLength): number {
  return modeShape(m, n, x0, y0, L);
}

/**
 * Generalized modal force for Uniform Acoustic Pressure p(t) over entire plate:
 * Q_mn(t) = integral_0^L integral_0^L p(t) * sin(m*pi*x/L) * sin(n*pi*y/L) dx dy
 * For odd m and odd n:
 * integral_0^L sin(k*pi*u/L) du = (L / k*pi) * (1 - cos(k*pi)) = 2L / (k*pi)
 * Coupling area = (2L / m*pi) * (2L / n*pi) = 4*L^2 / (m*n*pi^2)
 * For even m or even n:
 * Coupling is strictly 0 due to anti-symmetry!
 */
export function uniformPressureModalCoupling(m: number, n: number, L: number = DEFAULT_GEOMETRY.sideLength): number {
  if (m % 2 === 0 || n % 2 === 0) {
    return 0; // Strict cancellation for antisymmetric modes
  }
  return (4 * L * L) / (m * n * Math.PI * Math.PI);
}
