ALTER TABLE orders ADD COLUMN delivery JSONB;
COMMENT ON COLUMN orders.delivery IS 'Parcel delivery details for courier tariffs: recipientName, recipientPhone, item, code (4-digit proof-of-delivery PIN shown only to the sender); NULL for rides';
