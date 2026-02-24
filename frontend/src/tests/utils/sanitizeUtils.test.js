import { describe, it, expect } from 'vitest'
import { sanitizeInput, sanitizeForDisplay, validateLotNumber } from '../../utils/sanitizeUtils'

describe('sanitizeUtils', () => {
  describe('sanitizeInput', () => {
    it('removes script tags', () => {
      const input = '<script>alert("xss")</script>Hello'
      const result = sanitizeInput(input)
      expect(result).toBe('Hello')
    })

    it('removes HTML tags', () => {
      const input = '<div>Hello</div>'
      const result = sanitizeInput(input)
      expect(result).toBe('Hello')
    })

    it('removes javascript: protocol', () => {
      const input = 'javascript:alert("xss")'
      const result = sanitizeInput(input)
      expect(result).not.toContain('javascript:')
    })

    it('removes event handlers', () => {
      const input = '<img onclick="alert(1)" src="x">'
      const result = sanitizeInput(input)
      expect(result).not.toContain('onclick')
    })

    it('handles non-string input', () => {
      expect(sanitizeInput(123)).toBe(123)
      expect(sanitizeInput(null)).toBe(null)
    })
  })

  describe('sanitizeForDisplay', () => {
    it('escapes HTML entities', () => {
      // Test that & is escaped (this won't be removed by sanitizeInput)
      const input1 = 'Price & value'
      const result1 = sanitizeForDisplay(input1)
      expect(result1).toContain('&amp;')
      
      // Test that quotes are escaped
      const input2 = 'He said "hello"'
      const result2 = sanitizeForDisplay(input2)
      expect(result2).toContain('&quot;')
      
      // Test that apostrophes are escaped
      const input3 = "It's working"
      const result3 = sanitizeForDisplay(input3)
      expect(result3).toContain('&#x27;')
    })

    it('handles empty string', () => {
      expect(sanitizeForDisplay('')).toBe('')
      expect(sanitizeForDisplay(null)).toBe('')
    })
  })

  describe('validateLotNumber', () => {
    it('validates correct lot number', () => {
      const result = validateLotNumber('LOT123', [])
      expect(result.valid).toBe(true)
    })

    it('rejects empty lot number', () => {
      const result = validateLotNumber('', [])
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Lot number cannot be empty')
    })

    it('rejects duplicate lot number', () => {
      const result = validateLotNumber('LOT123', ['LOT123'])
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Lot number already exists')
    })

    it('rejects non-string input', () => {
      const result = validateLotNumber(null, [])
      expect(result.valid).toBe(false)
    })
  })
})
