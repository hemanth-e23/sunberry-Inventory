import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ContainerLabel, { ContainerLabelSheet } from '../../components/ingredient/ContainerLabel'
import { setAppTimezone } from '../../utils/dateUtils'

// RCV is a real instant and goes through dateUtils, so the label's output
// depends on the warehouse timezone being set the way login sets it.
setAppTimezone('America/New_York')

const container = (over = {}) => ({
  id: 'ctr-1',
  serial: 'B-260803-0042-017',
  sequence: 17,
  intake_lot_id: 'lot-a',
  vendor_lot: '389641',
  bbd: '2027-02-15T00:00:00Z',
  net_weight: 500,
  qty_unit: 'lb',
  product_name: 'Conventional Guava Puree',
  product_sid: 'MNGP',
  vendor_name: 'SunOpta',
  receipt_date: '2026-08-03T14:00:00Z',
  ...over,
})

const qrLabel = (view) => view.container.querySelector('.container-label__qr-svg')?.getAttribute('aria-label')

describe('ContainerLabel', () => {
  it('renders every field §5 requires', () => {
    render(<ContainerLabel container={container()} totalCount={80} />)

    expect(screen.getByText('CONVENTIONAL GUAVA PUREE')).toBeInTheDocument()
    expect(screen.getByText('17 of 80')).toBeInTheDocument()
    expect(screen.getByText('MNGP')).toBeInTheDocument()
    expect(screen.getByText('SunOpta')).toBeInTheDocument()
    expect(screen.getByText('389641')).toBeInTheDocument()
    expect(screen.getByText('02/15/2027')).toBeInTheDocument()
    expect(screen.getByText('500 LB')).toBeInTheDocument()
    expect(screen.getByText('08/03/2026')).toBeInTheDocument()
  })

  it('carries EXACTLY ONE scannable code, and it is the QR', () => {
    const view = render(<ContainerLabel container={container()} totalCount={80} />)
    expect(view.container.querySelectorAll('.container-label__qr-svg')).toHaveLength(1)
    expect(qrLabel(view)).toBe('SB1|B-260803-0042-017|389641|20270215')
  })

  it('does not shift the BBD across a timezone (midnight-UTC best-by)', () => {
    // The whole point of the lexical read: 02/15, never 02/14, in a US warehouse.
    render(<ContainerLabel container={container()} totalCount={80} />)
    expect(screen.getByText('02/15/2027')).toBeInTheDocument()
    expect(screen.queryByText('02/14/2027')).not.toBeInTheDocument()
  })

  it('DOES convert RCV into the warehouse day, because it is a real instant', () => {
    // 01:00Z Aug 4 is still 21:00 on Aug 3 in New York — the truck landed Aug 3.
    render(
      <ContainerLabel
        container={container({ receipt_date: '2026-08-04T01:00:00Z' })}
        totalCount={80}
      />,
    )
    expect(screen.getByText('08/03/2026')).toBeInTheDocument()
  })

  it('zero-pads both dates so the adjacent BBD/RCV lines cannot be misread', () => {
    // §5 mock: "BBD 02/15/2027" / "RCV 08/03/2026" — not dateUtils' bare 8/3/2026.
    render(<ContainerLabel container={container()} totalCount={80} />)
    expect(screen.getByText('08/03/2026')).toBeInTheDocument()
    expect(screen.queryByText('8/3/2026')).not.toBeInTheDocument()
  })

  it('keeps the QR and the printed LOT line in agreement when the lot is unknown', () => {
    const view = render(
      <ContainerLabel container={container({ lot_unknown: true })} totalCount={80} />,
    )
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument()
    // stale vendor_lot must NOT leak into the payload
    expect(qrLabel(view)).toBe('SB1|B-260803-0042-017||20270215')
  })

  it('degrades instead of crashing when display joins are missing', () => {
    const view = render(<ContainerLabel container={{ serial: 'B-1', sequence: 3 }} />)
    expect(screen.getByText('UNKNOWN PRODUCT')).toBeInTheDocument()
    // No intake total known -> bare number, never a wrong "3 of 1".
    expect(screen.getByText('NO. 3')).toBeInTheDocument()
    expect(qrLabel(view)).toBe('SB1|B-1||')
  })

  it('renders a blank code placeholder rather than throwing when there is no serial', () => {
    const view = render(<ContainerLabel container={{ product_name: 'Mystery' }} />)
    expect(view.container.querySelector('.container-label__qr-fallback')).toBeInTheDocument()
    expect(view.container.querySelector('.container-label__qr-svg')).toBeNull()
  })
})

describe('ContainerLabelSheet', () => {
  const rows = [
    container({ id: 'c3', serial: 'B-3', sequence: 2, intake_lot_id: 'lot-b', vendor_lot: 'BBB' }),
    container({ id: 'c1', serial: 'B-1', sequence: 10, intake_lot_id: 'lot-a', vendor_lot: 'AAA' }),
    container({ id: 'c2', serial: 'B-2', sequence: 1, intake_lot_id: 'lot-b', vendor_lot: 'BBB' }),
    container({ id: 'c0', serial: 'B-0', sequence: 2, intake_lot_id: 'lot-a', vendor_lot: 'AAA' }),
  ]

  const serialsInOrder = (view) => [...view.container.querySelectorAll('.container-label__serial-svg')]
    .map((el) => el.getAttribute('aria-label'))

  it('prints per-lot stacks in sequence order, never interleaved', () => {
    const view = render(<ContainerLabelSheet containers={rows} totalCount={80} />)
    expect(serialsInOrder(view)).toEqual(['B-0', 'B-1', 'B-2', 'B-3'])
  })

  it('puts a divider BETWEEN stacks and never before the first', () => {
    const view = render(<ContainerLabelSheet containers={rows} totalCount={80} />)
    const dividers = view.container.querySelectorAll('.container-label--divider')
    expect(dividers).toHaveLength(1)
    expect(dividers[0].textContent).toContain('BBB')
    // The divider must not be the very first page in the stack.
    const kids = [...view.container.querySelector('.container-label-sheet').children]
    expect(kids[0].className).not.toContain('divider')
  })

  it('prints no divider for a single-lot stack', () => {
    const view = render(
      <ContainerLabelSheet containers={rows.filter((r) => r.intake_lot_id === 'lot-a')} />,
    )
    expect(view.container.querySelectorAll('.container-label--divider')).toHaveLength(0)
  })

  it('lays every label out as a direct child so the print CSS can paginate', () => {
    // page-break-after / :last-child in ContainerLabel.css rely on this.
    const view = render(<ContainerLabelSheet containers={rows} totalCount={80} />)
    const sheet = view.container.querySelector('.container-label-sheet')
    expect(sheet.children).toHaveLength(5) // 4 labels + 1 divider
    expect([...sheet.children].every((c) => c.classList.contains('container-label'))).toBe(true)
  })

  it('renders nothing rather than crashing on empty input', () => {
    const view = render(<ContainerLabelSheet containers={[]} />)
    expect(view.container.querySelectorAll('.container-label')).toHaveLength(0)
  })
})
