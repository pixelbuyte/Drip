'use client';

import { useState } from 'react';

export default function SaveButton({ label }: { label: string }) {
  const [saved, setSaved] = useState(false);

  return (
    <button
      type="button"
      className="save-btn"
      data-saved={saved}
      aria-pressed={saved}
      aria-label={`Save ${label}`}
      onClick={() => setSaved((v) => !v)}
    >
      <svg className="save-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden>
        <path d="M12 21C12 21 4 15.5 4 9.8C4 6.6 6.4 4.5 9 4.5C10.3 4.5 11.4 5.1 12 6C12.6 5.1 13.7 4.5 15 4.5C17.6 4.5 20 6.6 20 9.8C20 15.5 12 21 12 21Z" />
      </svg>
    </button>
  );
}
