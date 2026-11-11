import express from 'express';
import { randomUUID } from 'node:crypto';
import db, { withTransaction } from './db.js';
import { centsToDecimal } from './money.js';
import { safeEqual } from './security.js';

export const app = express();

const formatItem = (row) => ({
  book_id: row.book_id,
  title: row.title,
  author: row.author,
  price: centsToDecimal(row.price_cents),
  quantity: row.quantity
});

// Middleware to ensure that Content-Type is application/json for writing requests
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(400).json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
});

// Standard JSON body parser
app.use(express.json());

// Strict body-parsing middleware:
// POST requests must carry a JSON object body (and reject arrays, scalars, null, or empty/missing bodies with 400).
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const body = req.body;

    // Reject if body is missing, not an object, is null, or is an array
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid or missing JSON body' });
    }

    // Reject empty/missing body (e.g. content-length is 0 or missing, and transfer-encoding is not chunked,
    // and there are no keys in the parsed body)
    const contentLength = req.headers['content-length'];
    const isChunked = req.headers['transfer-encoding'] === 'chunked';
    if ((contentLength === '0' || (!contentLength && !isChunked)) && Object.keys(body).length === 0) {
      return res.status(400).json({ error: 'Invalid or missing JSON body' });
    }
  }
  next();
});

// GET /health - Bearer token admin authentication, probe access without token
app.get('/health', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = match[1];
    const adminToken = process.env.ADMIN_TOKEN || '';
    if (!adminToken || !safeEqual(token, adminToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.json({ status: 'ok', admin: true });
  }
  return res.json({ status: 'ok' });
});

// GET /books - list books, format cents to decimal strings
app.get('/books', (req, res) => {
  try {
    const books = db.prepare('SELECT id, title, author, price_cents, stock FROM books').all();
    const formattedBooks = books.map(book => ({
      id: book.id,
      title: book.title,
      author: book.author,
      price: centsToDecimal(book.price_cents),
      stock: book.stock
    }));
    return res.json(formattedBooks);
  } catch (err) {
    console.error('Error fetching books:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /books/:id - single book detail, 404 on missing
app.get('/books/:id', (req, res) => {
  try {
    const bookIdStr = req.params.id;
    if (!/^[0-9]+$/.test(bookIdStr)) {
      return res.status(400).json({ error: 'Invalid book ID format' });
    }
    const bookId = Number(bookIdStr);
    const book = db.prepare('SELECT id, title, author, price_cents, stock FROM books WHERE id = ?').get(bookId);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }
    return res.json({
      id: book.id,
      title: book.title,
      author: book.author,
      price: centsToDecimal(book.price_cents),
      stock: book.stock
    });
  } catch (err) {
    console.error(`Error fetching book ${req.params.id}:`, err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /carts - creates new cart with UUID
app.post('/carts', (req, res) => {
  try {
    const cartId = randomUUID();
    db.prepare("INSERT INTO carts (id, status) VALUES (?, 'open')").run(cartId);
    
    const cart = db.prepare('SELECT id, status, created_at FROM carts WHERE id = ?').get(cartId);
    return res.status(201).json(cart);
  } catch (err) {
    console.error('Error creating cart:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /carts/:id - views cart and its items, 404 if missing
app.get('/carts/:id', (req, res) => {
  try {
    const cartId = req.params.id;
    const cart = db.prepare('SELECT id, status, created_at FROM carts WHERE id = ?').get(cartId);
    if (!cart) {
      return res.status(404).json({ error: 'Cart not found' });
    }
    
    const items = db.prepare(`
      SELECT ci.book_id, b.title, b.author, b.price_cents, ci.quantity
      FROM cart_items ci
      JOIN books b ON ci.book_id = b.id
      WHERE ci.cart_id = ?
    `).all(cartId);
    
    const formattedItems = items.map(formatItem);
    
    return res.json({
      id: cart.id,
      status: cart.status,
      created_at: cart.created_at,
      items: formattedItems
    });
  } catch (err) {
    console.error(`Error fetching cart ${req.params.id}:`, err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /carts/:id/items - adds book with quantity, validates input, updates quantity on second add, verifies stock limits, rejects if checked out with 409, 404 on missing book/cart
app.post('/carts/:id/items', (req, res) => {
  const cartId = req.params.id;
  const { book_id, quantity } = req.body;
  
  // Input validation
  if (book_id === undefined || quantity === undefined) {
    return res.status(400).json({ error: 'book_id and quantity are required' });
  }
  
  if (!Number.isInteger(book_id) || book_id <= 0) {
    return res.status(400).json({ error: 'book_id must be a positive integer' });
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive integer' });
  }
  
  try {
    const result = withTransaction(db, () => {
      // Check cart existence and status
      const cart = db.prepare('SELECT id, status FROM carts WHERE id = ?').get(cartId);
      if (!cart) {
        return { status: 404, data: { error: 'Cart not found' } };
      }
      if (cart.status === 'checked_out') {
        return { status: 409, data: { error: 'Cart is already checked out' } };
      }
      
      // Check book existence and stock
      const book = db.prepare('SELECT id, stock FROM books WHERE id = ?').get(book_id);
      if (!book) {
        return { status: 404, data: { error: 'Book not found' } };
      }
      
      // Check if item already exists in cart
      const existingItem = db.prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND book_id = ?').get(cartId, book_id);
      
      const currentQuantityInCart = existingItem ? existingItem.quantity : 0;
      const newQuantity = currentQuantityInCart + quantity;
      
      if (newQuantity > book.stock) {
        return { status: 409, data: { error: 'Not enough stock available' } };
      }
      
      if (existingItem) {
        db.prepare('UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND book_id = ?').run(newQuantity, cartId, book_id);
      } else {
        db.prepare('INSERT INTO cart_items (cart_id, book_id, quantity) VALUES (?, ?, ?)').run(cartId, book_id, quantity);
      }
      
      // Get the updated item detail to return
      const updatedItem = db.prepare(`
        SELECT ci.book_id, b.title, b.author, b.price_cents, ci.quantity
        FROM cart_items ci
        JOIN books b ON ci.book_id = b.id
        WHERE ci.cart_id = ? AND ci.book_id = ?
      `).get(cartId, book_id);
      
      return { status: 200, data: formatItem(updatedItem) };
    });
    
    return res.status(result.status).json(result.data);
  } catch (err) {
    console.error(`Error updating items for cart ${cartId}:`, err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /carts/:id/checkout - transactional checkout, decreases stock, duplicates metadata to frozen order_items, marks cart checked out, returns 201 order
app.post('/carts/:id/checkout', (req, res) => {
  const cartId = req.params.id;
  
  try {
    const result = withTransaction(db, () => {
      // Check cart existence
      const cart = db.prepare('SELECT id, status FROM carts WHERE id = ?').get(cartId);
      if (!cart) {
        return { status: 404, data: { error: 'Cart not found' } };
      }
      
      // Check if already checked out
      if (cart.status === 'checked_out') {
        return { status: 409, data: { error: 'Cart is already checked out' } };
      }
      
      // Retrieve items in cart along with their book details
      const cartItems = db.prepare(`
        SELECT ci.book_id, ci.quantity, b.title, b.author, b.price_cents, b.stock
        FROM cart_items ci
        JOIN books b ON ci.book_id = b.id
        WHERE ci.cart_id = ?
      `).all(cartId);
      
      if (cartItems.length === 0) {
        return { status: 400, data: { error: 'Cannot checkout an empty cart' } };
      }
      
      // Verify stock for all items
      for (const item of cartItems) {
        if (item.stock < item.quantity) {
          return { status: 409, data: { error: `Not enough stock for book: ${item.title}` } };
        }
      }
      
      // Calculate total
      let totalCents = 0;
      for (const item of cartItems) {
        totalCents += item.price_cents * item.quantity;
      }
      
      // Decrement stock for each book
      const updateStockStmt = db.prepare('UPDATE books SET stock = stock - ? WHERE id = ?');
      for (const item of cartItems) {
        updateStockStmt.run(item.quantity, item.book_id);
      }
      
      // Mark cart as checked out
      db.prepare("UPDATE carts SET status = 'checked_out' WHERE id = ?").run(cartId);
      
      // Generate Order UUID
      const orderId = randomUUID();
      
      // Insert order
      db.prepare('INSERT INTO orders (id, cart_id, total_cents) VALUES (?, ?, ?)')
        .run(orderId, cartId, totalCents);
        
      // Insert order items from current book metadata (frozen details)
      const insertOrderItemStmt = db.prepare(`
        INSERT INTO order_items (order_id, book_id, title, author, price_cents, quantity)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      for (const item of cartItems) {
        insertOrderItemStmt.run(
          orderId,
          item.book_id,
          item.title,
          item.author,
          item.price_cents,
          item.quantity
        );
      }
      
      // Retrieve the saved order and order items
      const savedOrder = db.prepare('SELECT id, cart_id, total_cents, created_at FROM orders WHERE id = ?').get(orderId);
      const savedOrderItems = db.prepare('SELECT book_id, title, author, price_cents, quantity FROM order_items WHERE order_id = ?').all(orderId);
      
      const formattedItems = savedOrderItems.map(formatItem);
      
      return {
        status: 201,
        data: {
          id: savedOrder.id,
          cart_id: savedOrder.cart_id,
          total: centsToDecimal(savedOrder.total_cents),
          created_at: savedOrder.created_at,
          items: formattedItems
        }
      };
    });
    
    return res.status(result.status).json(result.data);
  } catch (err) {
    console.error(`Error during checkout for cart ${cartId}:`, err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /orders/:id - returns checked out order details, 404 if missing
app.get('/orders/:id', (req, res) => {
  try {
    const orderId = req.params.id;
    const order = db.prepare('SELECT id, cart_id, total_cents, created_at FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const orderItems = db.prepare('SELECT book_id, title, author, price_cents, quantity FROM order_items WHERE order_id = ?').all(orderId);
    
    const formattedItems = orderItems.map(formatItem);
    
    return res.json({
      id: order.id,
      cart_id: order.cart_id,
      total: centsToDecimal(order.total_cents),
      created_at: order.created_at,
      items: formattedItems
    });
  } catch (err) {
    console.error(`Error fetching order ${req.params.id}:`, err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Global error-handling middleware for Graceful JSON parsing error responses
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal Server Error' });
});

export default app;
