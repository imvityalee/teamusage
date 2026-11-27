import data from "./worst-case.json";

/** People and names a real team can hold and a layout must survive; each value is within the server's own limits. */
export const worstCase: { people: { name: string; email: string }[]; teamName: string; machineLabel: string; login: string } = data;
