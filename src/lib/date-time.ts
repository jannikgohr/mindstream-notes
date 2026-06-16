const NOTE_DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
};

export function formatNoteDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, NOTE_DATE_TIME_FORMAT).format(
      new Date(iso)
    );
  } catch {
    return iso;
  }
}
