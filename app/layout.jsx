// app/layout.jsx
import './globals.css';

export const metadata = {
  title: 'Content search',
  description: 'Search the full text of every page across your properties.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
