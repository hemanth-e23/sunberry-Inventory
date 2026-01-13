// Input sanitization utility
export const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  
  // Remove potentially dangerous HTML tags and scripts
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
};

export const sanitizeForDisplay = (text) => {
  if (!text) return '';
  const sanitized = sanitizeInput(String(text));
  // Escape HTML entities
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

export const validateLotNumber = (lotNumber, existingLotNumbers = []) => {
  if (lotNumber === null || lotNumber === undefined || typeof lotNumber !== 'string') {
    return { valid: false, error: 'Lot number is required' };
  }
  
  const trimmed = lotNumber.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Lot number cannot be empty' };
  }
  
  if (existingLotNumbers.includes(trimmed)) {
    return { valid: false, error: 'Lot number already exists' };
  }
  
  return { valid: true };
};

