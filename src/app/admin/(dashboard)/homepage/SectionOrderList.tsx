"use client";

import { useEffect, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { HomepageSection } from "@/lib/admin-queries";
import { reorderHomepageSections } from "../../actions";
import { HomepageVisibilityToggle } from "./HomepageVisibilityToggle";
import { HomepageSectionForm } from "./HomepageSectionForm";

const KIND_LABELS: Record<string, string> = { category: "قسم", feature: "ميزة" };

/** One draggable section card. The drag handle carries the sensor listeners so
 * the visibility toggle and the edit form inside stay fully clickable. */
function SortableCard({ section, position }: { section: HomepageSection; position: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`rounded-2xl border bg-white p-4 ${
        isDragging ? "border-teal/50 shadow-lg ring-2 ring-teal/30" : "border-line"
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          aria-label="اسحب لإعادة الترتيب"
          title="اسحب لإعادة الترتيب"
          {...attributes}
          {...listeners}
          className="flex h-8 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg border border-line text-gray hover:bg-cream active:cursor-grabbing"
        >
          ⠿
        </button>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cream font-sans text-[11px] font-bold text-teal">
          {position}
        </span>
        <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
          {KIND_LABELS[section.kind] ?? section.kind}
        </span>
        <span dir="ltr" className="font-sans text-[11px] text-gray">
          {section.key}
        </span>
      </div>

      <HomepageVisibilityToggle section={section} />
      <HomepageSectionForm section={section} />
    </li>
  );
}

/**
 * Drag-and-drop ordering for the homepage sections. Reordering is optimistic
 * (local state updates immediately) and persisted via `reorderHomepageSections`
 * on drop. Keyboard dragging is supported for accessibility.
 */
export function SectionOrderList({ sections }: { sections: HomepageSection[] }) {
  const [items, setItems] = useState(sections);

  // Keep local order in sync when the server sends a fresh list (e.g. after a
  // visibility toggle revalidates the page).
  useEffect(() => {
    setItems(sections);
  }, [sections]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((s) => s.id === active.id);
    const newIndex = items.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    void reorderHomepageSections(next.map((s) => s.id));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-3">
          {items.map((s, i) => (
            <SortableCard key={s.id} section={s} position={i + 1} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
