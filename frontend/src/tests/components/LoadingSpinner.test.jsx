import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import LoadingSpinner from '../../components/LoadingSpinner'

describe('LoadingSpinner', () => {
  it('renders without crashing', () => {
    render(<LoadingSpinner />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('displays custom text when provided', () => {
    render(<LoadingSpinner text="Loading data..." />)
    expect(screen.getByText('Loading data...')).toBeInTheDocument()
  })

  it('renders with different sizes', () => {
    const { container: small } = render(<LoadingSpinner size="sm" />)
    const { container: medium } = render(<LoadingSpinner size="md" />)
    const { container: large } = render(<LoadingSpinner size="lg" />)

    expect(small).toBeTruthy()
    expect(medium).toBeTruthy()
    expect(large).toBeTruthy()
  })
})
