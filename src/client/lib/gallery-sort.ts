/**
 * The four fixed orderings for the community grid. `sort` selects the column
 * the Worker orders by (`upload` = created_at, `captured` = captured_at) and
 * `order` its direction. The id is the DOM/value key shared with the popover.
 */

export type GallerySortKey = "upload" | "captured";
export type GalleryOrder = "desc" | "asc";

export interface GallerySortOption {
  id: string;
  label: string;
  sort: GallerySortKey;
  order: GalleryOrder;
}

export const DEFAULT_GALLERY_SORT_OPTION: GallerySortOption = {
  id: "upload-desc",
  label: "Newest uploads",
  sort: "upload",
  order: "desc",
};

export const GALLERY_SORT_OPTIONS: readonly GallerySortOption[] = [
  DEFAULT_GALLERY_SORT_OPTION,
  { id: "upload-asc", label: "Oldest uploads", sort: "upload", order: "asc" },
  { id: "captured-desc", label: "Newest captures", sort: "captured", order: "desc" },
  { id: "captured-asc", label: "Oldest captures", sort: "captured", order: "asc" },
];

export function gallerySortOption(id: string | null | undefined): GallerySortOption {
  return GALLERY_SORT_OPTIONS.find((option) => option.id === id) ?? DEFAULT_GALLERY_SORT_OPTION;
}
