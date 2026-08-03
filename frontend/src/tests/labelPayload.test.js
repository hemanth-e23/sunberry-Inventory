import { describe, it, expect } from 'vitest'
import {
  PAYLOAD_VERSION,
  encodeContainerPayload,
  decodeContainerPayload,
  toCalendarKey,
  toBbdCompact,
  fromBbdCompact,
  formatCalendarDate,
  groupContainersByLot,
  orderContainersForPrint,
} from '../utils/labelPayload'

const container = (over = {}) => ({
  serial: 'B-260803-0042-017',
  vendor_lot: '389641',
  bbd: '2027-02-15T00:00:00Z',
  ...over,
})

describe('labelPayload', () => {
  describe('encodeContainerPayload', () => {
    it('emits the fixed SB1 format', () => {
      expect(encodeContainerPayload(container()))
        .toBe('SB1|B-260803-0042-017|389641|20270215')
    })

    it('keeps four segments even when lot and BBD are absent', () => {
      const encoded = encodeContainerPayload({ serial: 'G-260803-0042-001' })
      expect(encoded).toBe('SB1|G-260803-0042-001||')
      expect(encoded.split('|')).toHaveLength(4)
    })

    it('reads the BBD calendar day lexically, never through a timezone', () => {
      // A midnight-UTC BBD must NOT shift back a day in a US warehouse tz.
      expect(encodeContainerPayload(container({ bbd: '2027-02-15T00:00:00Z' })))
        .toContain('|20270215')
      expect(encodeContainerPayload(container({ bbd: '2027-02-15' })))
        .toContain('|20270215')
    })

    it('rejects a pipe in the vendor lot rather than escaping it', () => {
      expect(() => encodeContainerPayload(container({ vendor_lot: '389|641' })))
        .toThrow(/vendor lot/i)
    })

    it('rejects a pipe in the serial', () => {
      expect(() => encodeContainerPayload(container({ serial: 'B|017' })))
        .toThrow(/serial/i)
    })

    it('requires a serial', () => {
      expect(() => encodeContainerPayload({ vendor_lot: '389641' })).toThrow(/serial/i)
      expect(() => encodeContainerPayload({ serial: '   ' })).toThrow(/serial/i)
    })

    it('does not throw on an unreadable BBD — the segment just goes out empty', () => {
      expect(encodeContainerPayload(container({ bbd: 'sometime next year' })))
        .toBe('SB1|B-260803-0042-017|389641|')
    })

    it('trims whitespace off both fields', () => {
      expect(encodeContainerPayload({ serial: ' B-1 ', vendor_lot: ' 42 ' }))
        .toBe('SB1|B-1|42|')
    })

    it('accepts camelCase aliases', () => {
      expect(encodeContainerPayload({ serial: 'B-1', vendorLot: '42' }))
        .toBe('SB1|B-1|42|')
    })
  })

  describe('decodeContainerPayload', () => {
    it('round-trips an encoded payload', () => {
      const decoded = decodeContainerPayload(encodeContainerPayload(container()))
      expect(decoded).toEqual({
        version: PAYLOAD_VERSION,
        serial: 'B-260803-0042-017',
        vendorLot: '389641',
        bbd: '2027-02-15',
        bare: false,
        unknownVersion: false,
      })
    })

    it('parses a bare serial with no pipe (hand-keyed / X-3 relabel)', () => {
      const decoded = decodeContainerPayload('B-260803-0042-017')
      expect(decoded.serial).toBe('B-260803-0042-017')
      expect(decoded.bare).toBe(true)
      expect(decoded.version).toBeNull()
      expect(decoded.vendorLot).toBe('')
      expect(decoded.bbd).toBe('')
    })

    it('recovers the serial from a future version, because fields are additive', () => {
      const decoded = decodeContainerPayload('SB2|B-260803-0042-017|389641|20270215|EXTRA')
      expect(decoded.serial).toBe('B-260803-0042-017')
      expect(decoded.vendorLot).toBe('389641')
      expect(decoded.bbd).toBe('2027-02-15')
      expect(decoded.unknownVersion).toBe(true)
      expect(decoded.version).toBe('SB2')
    })

    it('returns null for a delimited string that is not one of our labels', () => {
      expect(decodeContainerPayload('FOO|BAR|BAZ')).toBeNull()
      expect(decodeContainerPayload('|B-1|42|')).toBeNull()
    })

    it('returns null for empty / nullish input', () => {
      expect(decodeContainerPayload('')).toBeNull()
      expect(decodeContainerPayload('   ')).toBeNull()
      expect(decodeContainerPayload(null)).toBeNull()
      expect(decodeContainerPayload(undefined)).toBeNull()
    })

    it('returns null when the envelope is present but the serial is empty', () => {
      expect(decodeContainerPayload('SB1||389641|20270215')).toBeNull()
    })

    it('trims scanner whitespace / newline', () => {
      expect(decodeContainerPayload('  SB1|B-1|42|20270215\n').serial).toBe('B-1')
    })

    it('empties an impossible BBD rather than reporting a fake date', () => {
      expect(decodeContainerPayload('SB1|B-1|42|20271345').bbd).toBe('')
      expect(decodeContainerPayload('SB1|B-1|42|nope').bbd).toBe('')
      expect(decodeContainerPayload('SB1|B-1|42|').bbd).toBe('')
    })
  })

  describe('date helpers', () => {
    it('toCalendarKey reads the leading ISO day', () => {
      expect(toCalendarKey('2027-02-15T23:59:00+05:00')).toBe('2027-02-15')
      expect(toCalendarKey('2027-02-15')).toBe('2027-02-15')
      expect(toCalendarKey('')).toBe('')
      expect(toCalendarKey(null)).toBe('')
      expect(toCalendarKey('2027-13-01')).toBe('')
    })

    it('toBbdCompact / fromBbdCompact invert each other', () => {
      expect(toBbdCompact('2027-02-15')).toBe('20270215')
      expect(fromBbdCompact('20270215')).toBe('2027-02-15')
      expect(fromBbdCompact('2027021')).toBe('')
    })

    it('formatCalendarDate renders MM/DD/YYYY and echoes junk through', () => {
      expect(formatCalendarDate('2027-02-15T00:00:00Z')).toBe('02/15/2027')
      expect(formatCalendarDate('')).toBe('')
      expect(formatCalendarDate('whenever')).toBe('whenever')
    })
  })

  describe('print ordering', () => {
    const rows = [
      { id: '3', intake_lot_id: 'lot-b', sequence: 2, serial: 'B-3', vendor_lot: 'BBB' },
      { id: '1', intake_lot_id: 'lot-a', sequence: 10, serial: 'B-1', vendor_lot: 'AAA' },
      { id: '2', intake_lot_id: 'lot-b', sequence: 1, serial: 'B-2', vendor_lot: 'BBB' },
      { id: '0', intake_lot_id: 'lot-a', sequence: 2, serial: 'B-0', vendor_lot: 'AAA' },
    ]

    it('groups into per-lot stacks ordered by sequence', () => {
      const groups = groupContainersByLot(rows)
      expect(groups.map((g) => g.intakeLotId)).toEqual(['lot-a', 'lot-b'])
      expect(groups[0].containers.map((c) => c.sequence)).toEqual([2, 10])
      expect(groups[1].containers.map((c) => c.sequence)).toEqual([1, 2])
      expect(groups[0].vendorLot).toBe('AAA')
    })

    it('never interleaves lots in the flat stack', () => {
      const lots = orderContainersForPrint(rows).map((c) => c.intake_lot_id)
      expect(lots).toEqual(['lot-a', 'lot-a', 'lot-b', 'lot-b'])
    })

    it('sorts numerically, not lexically', () => {
      const ordered = orderContainersForPrint([
        { intake_lot_id: 'x', sequence: 10 },
        { intake_lot_id: 'x', sequence: 9 },
        { intake_lot_id: 'x', sequence: 100 },
      ])
      expect(ordered.map((c) => c.sequence)).toEqual([9, 10, 100])
    })

    it('prints unknown-lot containers last', () => {
      const ordered = orderContainersForPrint([
        { intake_lot_id: null, sequence: 1, serial: 'ORPHAN' },
        { intake_lot_id: 'lot-a', sequence: 1, serial: 'B-1' },
      ])
      expect(ordered.map((c) => c.serial)).toEqual(['B-1', 'ORPHAN'])
    })

    it('tolerates empty / nullish input and null rows', () => {
      expect(orderContainersForPrint([])).toEqual([])
      expect(orderContainersForPrint()).toEqual([])
      expect(orderContainersForPrint([null, undefined])).toEqual([])
    })

    it('does not mutate the caller array', () => {
      const input = [...rows]
      orderContainersForPrint(input)
      expect(input.map((c) => c.id)).toEqual(['3', '1', '2', '0'])
    })
  })
})
