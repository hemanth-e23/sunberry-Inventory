import React from 'react';

const shimmerStyle = {
  background: 'linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 50%, #f0f0f0 75%)',
  backgroundSize: '200% 100%',
  animation: 'skeletonShimmer 1.4s infinite',
  borderRadius: '4px',
  height: '14px',
};

const rowStyle = {
  borderBottom: '1px solid var(--color-border, #e5e7eb)',
};

const tdStyle = {
  padding: '12px 16px',
  verticalAlign: 'middle',
};

/**
 * Drop-in replacement for <tbody> during loading.
 * Usage: replace <tbody>...</tbody> with <TableSkeleton columns={7} rows={8} />
 */
const TableSkeleton = ({ rows = 8, columns = 6 }) => (
  <>
    <style>{`
      @keyframes skeletonShimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `}</style>
    <tbody>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex} style={rowStyle}>
          {Array.from({ length: columns }).map((_, colIndex) => (
            <td key={colIndex} style={tdStyle}>
              <div
                style={{
                  ...shimmerStyle,
                  width: colIndex === 0 ? '48px' : colIndex === columns - 1 ? '72px' : `${70 + (colIndex * 7) % 30}%`,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </>
);

export default TableSkeleton;
