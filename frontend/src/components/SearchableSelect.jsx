import React, { useEffect, useMemo, useRef, useState } from "react";
import "./SearchableSelect.css";

const SearchableSelect = ({
  options = [],
  value = "",
  onChange,
  placeholder = "Select option",
  searchPlaceholder = "Type to search...",
  disabled = false,
  required = false,
  name,
  id,
  allowEmptyOption,
  emptyLabel = "Select option",
  className = "",
  noMatchesLabel = "No matches",
  showChevron = true,
}) => {
  const normalizedOptions = Array.isArray(options) ? options : [];
  const resolvedAllowEmpty =
    typeof allowEmptyOption === "boolean" ? allowEmptyOption : !required;

  const containerRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  const extendedOptions = useMemo(() => {
    const base = normalizedOptions.map((option) => ({
      ...option,
      label: option.label ?? String(option.value ?? ""),
      value: option.value ?? "",
    }));
    return resolvedAllowEmpty
      ? [{ value: "", label: emptyLabel, __isEmpty: true }, ...base]
      : base;
  }, [normalizedOptions, resolvedAllowEmpty, emptyLabel]);

  const selectedOption = useMemo(
    () => extendedOptions.find((option) => option.value === value) || null,
    [extendedOptions, value],
  );

  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return extendedOptions;
    return extendedOptions.filter((option) =>
      option.label.toLowerCase().includes(term),
    );
  }, [extendedOptions, query]);

  useEffect(() => {
    if (!open) {
      setQuery(selectedOption ? selectedOption.label : "");
    }
  }, [selectedOption, open]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) {
      const idx = filteredOptions.findIndex((option) => option.value === value);
      setHighlightIndex(idx >= 0 ? idx : 0);
    } else {
      setHighlightIndex((prev) =>
        Math.min(prev, Math.max(filteredOptions.length - 1, 0)),
      );
    }
  }, [filteredOptions, value, open]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("li");
    if (items.length === 0) return;
    const activeItem = items[highlightIndex];
    if (activeItem && activeItem.scrollIntoView) {
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex, open]);

  const openDropdown = () => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  };

  const closeDropdown = () => {
    setOpen(false);
    setQuery(selectedOption ? selectedOption.label : "");
  };

  const handleSelect = (option) => {
    setOpen(false);
    setQuery(option.label || "");
    if (option.value === value) {
      return;
    }
    onChange?.(option.value);
  };

  const handleKeyDown = (event) => {
    if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openDropdown();
      return;
    }

    if (!open) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightIndex((prev) =>
        Math.min(prev + 1, Math.max(filteredOptions.length - 1, 0)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[highlightIndex];
      if (option) handleSelect(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeDropdown();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`searchable-select ${className} ${disabled ? "disabled" : ""}`.trim()}
    >
      <div className={`searchable-select__input ${open ? "open" : ""}`}>
        <input
          ref={inputRef}
          id={id}
          type="text"
          name={name ? `${name}-search` : undefined}
          value={query}
          placeholder={selectedOption ? placeholder : searchPlaceholder}
          disabled={disabled}
          onFocus={openDropdown}
          onChange={(event) => {
            if (!open) {
              openDropdown();
            }
            setQuery(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (!containerRef.current?.contains(document.activeElement)) {
              closeDropdown();
            }
          }}
          aria-expanded={open}
          aria-haspopup="listbox"
          autoComplete="off"
        />
        {showChevron && (
          <button
            type="button"
            className="searchable-select__chevron"
            onMouseDown={(event) => {
              event.preventDefault();
              open ? closeDropdown() : openDropdown();
            }}
            aria-label="Toggle options"
          >
            ▾
          </button>
        )}
      </div>
      <input type="hidden" name={name} value={value || ""} required={required} />
      {open && (
        <ul className="searchable-select__list" role="listbox" ref={listRef}>
          {filteredOptions.length === 0 ? (
            <li className="empty" aria-disabled>
              {noMatchesLabel}
            </li>
          ) : (
            filteredOptions.map((option, index) => {
              const isSelected = option.value === value;
              const isHighlighted = index === highlightIndex;
              return (
                <li
                  key={`${option.value}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`${isSelected ? "selected" : ""} ${isHighlighted ? "active" : ""}`.trim()}
                  tabIndex={-1}
                  onMouseEnter={() => setHighlightIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    handleSelect(option);
                  }}
                >
                  {option.label}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
};

export default SearchableSelect;

