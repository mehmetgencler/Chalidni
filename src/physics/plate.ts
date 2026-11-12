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

export interface ModeCatalogueItem {
  m: number;
  n: number;
  frequency: number;     // Natural frequency in Hz
  omega: number;         // Angular frequency in rad/s
  modalMass: number;     // M_mn in kg
  centerCoupling: number;// phi_mn(L/2, L/2) = sin(m*pi/2)*sin(n*pi/2)
  isOddOdd: boolean;     // Whether both m and n are odd (coupled to center probe)
}

/**
 * Generates the full Kirchhoff-Love modal catalogue up to maxFrequency (default 20,000 Hz).
 * For the standard 0.30 m aluminum plate (f11 ~ 53.963 Hz), this produces 557 modes,
 * of which 146 are odd-odd modes actively coupled to center excitation.
 */
export function generateModalCatalogue(
  maxFrequency: number = 20000,
  material: PlateMaterial = DEFAULT_ALUMINUM,
  geometry: PlateGeometry = DEFAULT_GEOMETRY
): ModeCatalogueItem[] {
  const catalogue: ModeCatalogueItem[] = [];
  const M = calculateModalMass(material, geometry);
  const L = geometry.sideLength;

  const f11 = calculateAnalyticalFrequency(1, 1, material, geometry);
  const maxM = Math.ceil(Math.sqrt((2 * maxFrequency) / f11));

  for (let m = 1; m <= maxM; m++) {
    for (let n = 1; n <= maxM; n++) {
      const f = calculateAnalyticalFrequency(m, n, material, geometry);
      if (f <= maxFrequency) {
        const isOddOdd = m % 2 !== 0 && n % 2 !== 0;
        const phiCenter = modeShape(m, n, L / 2, L / 2, L);
        catalogue.push({
          m,
          n,
          frequency: f,
          omega: 2 * Math.PI * f,
          modalMass: M,
          centerCoupling: phiCenter,
          isOddOdd,
        });
      }
    }
  }

  // Sort ascending by natural frequency
  catalogue.sort((a, b) => a.frequency - b.frequency);
  return catalogue;
}

export interface ModalPhasorComponent {
  m: number;
  n: number;
  aReal: number;
  aImag: number;
  coupling: number;
}

/**
 * Evaluates the coherent harmonic acceleration frequency response for a single test tone:
 * Omega = 2 * pi * fExcitation
 * Transfer function: H_mn(Omega) = 1 / [M * (omega_mn^2 - Omega^2 + i * 2 * zeta * omega_mn * Omega)]
 * Modal acceleration phasor: a_hat_mn = -Omega^2 * Q_mn * H_mn(Omega)
 * Total complex acceleration field: A_hat(x, y) = sum_mn [a_hat_mn * phi_mn(x, y)]
 * RMS acceleration: a_rms(x, y) = |A_hat(x, y)| / sqrt(2)
 */
export function computeHarmonicModalAccelerations(
  fExcitation: number,
  modes: ModeCatalogueItem[],
  F0: number = 2.0,
  zeta: number = 0.01
): ModalPhasorComponent[] {
  const Omega = 2 * Math.PI * Math.max(1.0, fExcitation);
  const Omega2 = Omega * Omega;
  const results: ModalPhasorComponent[] = [];

  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    if (Math.abs(mode.centerCoupling) < 1e-6) continue;

    const omega = mode.omega;
    const M = mode.modalMass;
    const Q = F0 * mode.centerCoupling;

    const DReal = omega * omega - Omega2;
    const DImag = 2 * zeta * omega * Omega;
    const denomMag2 = DReal * DReal + DImag * DImag;
    if (denomMag2 < 1e-18) continue;

    const qPrefactor = Q / (M * denomMag2);
    const qReal = qPrefactor * DReal;
    const qImag = -qPrefactor * DImag;

    // aHat = -Omega^2 * qHat
    const aReal = -Omega2 * qReal;
    const aImag = -Omega2 * qImag;

    results.push({
      m: mode.m,
      n: mode.n,
      aReal,
      aImag,
      coupling: mode.centerCoupling,
    });
  }

  return results;
}

