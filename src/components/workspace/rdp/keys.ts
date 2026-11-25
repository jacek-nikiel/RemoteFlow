/** Keys that can be sent to the remote Windows session (scancodes), grouped for the key menu. */

export const SCANCODE_OPTIONS: { label: string; code: number; group: string }[] = [
  // Klawisze funkcyjne
  { label: 'F1', code: 0x003b, group: 'Klawisze funkcyjne' },
  { label: 'F2', code: 0x003c, group: 'Klawisze funkcyjne' },
  { label: 'F3', code: 0x003d, group: 'Klawisze funkcyjne' },
  { label: 'F4', code: 0x003e, group: 'Klawisze funkcyjne' },
  { label: 'F5', code: 0x003f, group: 'Klawisze funkcyjne' },
  { label: 'F6', code: 0x0040, group: 'Klawisze funkcyjne' },
  { label: 'F7', code: 0x0041, group: 'Klawisze funkcyjne' },
  { label: 'F8', code: 0x0042, group: 'Klawisze funkcyjne' },
  { label: 'F9', code: 0x0043, group: 'Klawisze funkcyjne' },
  { label: 'F10', code: 0x0044, group: 'Klawisze funkcyjne' },
  { label: 'F11', code: 0x0057, group: 'Klawisze funkcyjne' },
  { label: 'F12', code: 0x0058, group: 'Klawisze funkcyjne' },

  // Klawisze specjalne
  { label: 'Delete (Del)', code: 0xe053, group: 'Klawisze specjalne' },
  { label: 'Escape (Esc)', code: 0x0001, group: 'Klawisze specjalne' },
  { label: 'Tab', code: 0x000f, group: 'Klawisze specjalne' },
  { label: 'Enter', code: 0x001c, group: 'Klawisze specjalne' },
  { label: 'Backspace', code: 0x000e, group: 'Klawisze specjalne' },
  { label: 'Spacja (Space)', code: 0x0039, group: 'Klawisze specjalne' },
  { label: 'Insert (Ins)', code: 0xe052, group: 'Klawisze specjalne' },
  { label: 'Home', code: 0xe047, group: 'Klawisze specjalne' },
  { label: 'End', code: 0xe04f, group: 'Klawisze specjalne' },
  { label: 'Page Up', code: 0xe049, group: 'Klawisze specjalne' },
  { label: 'Page Down', code: 0xe051, group: 'Klawisze specjalne' },
  { label: 'Print Screen (PrtScn)', code: 0xe037, group: 'Klawisze specjalne' },

  // Nawigacja / Strzałki
  { label: 'Strzałka w górę (Up)', code: 0xe048, group: 'Nawigacja' },
  { label: 'Strzałka w dół (Down)', code: 0xe050, group: 'Nawigacja' },
  { label: 'Strzałka w lewo (Left)', code: 0xe04b, group: 'Nawigacja' },
  { label: 'Strzałka w prawo (Right)', code: 0xe04d, group: 'Nawigacja' },

  // Litery
  ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'].map((char) => ({
    label: char,
    code: ({
      A: 0x001e, B: 0x0030, C: 0x002e, D: 0x0020, E: 0x0012, F: 0x0021, G: 0x0022, H: 0x0023,
      I: 0x0017, J: 0x0024, K: 0x0025, L: 0x0026, M: 0x0032, N: 0x0031, O: 0x0018, P: 0x0019,
      Q: 0x0010, R: 0x0013, S: 0x001f, T: 0x0014, U: 0x0016, V: 0x002f, W: 0x0011, X: 0x002d,
      Y: 0x0015, Z: 0x002c,
    } as Record<string, number>)[char],
    group: 'Litery',
  })),

  // Cyfry
  ...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => ({
    label: num,
    code: ({
      '1': 0x0002, '2': 0x0003, '3': 0x0004, '4': 0x0005, '5': 0x0006,
      '6': 0x0007, '7': 0x0008, '8': 0x0009, '9': 0x000a, '0': 0x000b,
    } as Record<string, number>)[num],
    group: 'Cyfry',
  })),
];
