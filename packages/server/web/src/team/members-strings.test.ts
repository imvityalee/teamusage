import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ru } from "./strings/members.js";

test("a sync is «отправка» in the members card's Russian, as the glossary and the dashboard say it", () => {
  expect(ru).toMatchObject({
    notSyncing_one: "{n} не отправляет данные",
    notSyncing_few: "{n} не отправляют данные",
    notSyncing_many: "{n} не отправляют данные",
    filterStale: "Нет отправок",
    colSync: "Последняя отправка",
    machineSync: "Последняя отправка: {when}",
    syncNever: "не было",
    membersNoStale: "Все участники отправляют данные.",
    membersEmpty: "Пока никто не присоединился. Отправьте команде приглашение из блока выше.",
    tickAllAria: "Выбрать всех участников, подходящих под поиск и фильтр",
    selectedMax: "Выбрано {n} — больше за одно удаление нельзя.",
  });
});

test("no string of the team page says «синхрон»", () => {
  const dir = new URL("./strings/", import.meta.url);
  for (const file of readdirSync(dir)) expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/синхрон/i);
});
