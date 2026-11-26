/**
 * Picture settings the embedded RDP client sends: the color depth of the connection settings
 * (32-bit by default – IronRDP itself would ask for 16-bit, which spoils anti-aliased text).
 * The graphics pipeline (RDPEGFX) is IronRDP's default and is kept.
 */

/** Color depth the current session connected with (statistics panel). */
let activeDepth: number | null = null;
export const noteRdpColorDepth = (depth: number) => {
  activeDepth = depth;
};
export const activeRdpColorDepth = () => activeDepth;

/** A color depth IronRDP accepts (connection setting, 32 when unset or unusual). */
export const rdpColorDepth = (value: number | undefined): 15 | 16 | 24 | 32 =>
  value === 15 || value === 16 || value === 24 ? value : 32;
