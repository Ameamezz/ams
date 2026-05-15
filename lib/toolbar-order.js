'use strict';

function reorderToolbar(toolbar, id, direction) {
  const active = toolbar.filter((button) => !button.deleted);
  const deleted = toolbar.filter((button) => button.deleted);
  const index = active.findIndex((button) => button.id === id);
  const nextIndex = index + direction;

  if (index < 0 || nextIndex < 0 || nextIndex >= active.length) {
    return toolbar.slice();
  }

  const [item] = active.splice(index, 1);
  active.splice(nextIndex, 0, item);
  active.forEach((button, nextOrder) => {
    button.order = (nextOrder + 1) * 10;
  });
  return [...active, ...deleted];
}

module.exports = { reorderToolbar };
