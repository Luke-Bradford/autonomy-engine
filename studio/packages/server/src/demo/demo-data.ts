/**
 * #1481 OR32 — the demo ETL pack's landing files, embedded so they ship inside
 * the server's build output (and so the Docker image) with no asset-copy step.
 *
 * Byte-identical to the operator's deterministic generator (`gen_data.py`,
 * fixed seed 20260901) that built the hand-run demo on 2026-10-02. Planted
 * dirt, which the demo's cleaning SQL must account for exactly: padded strings,
 * mixed-case countries, blank customers, qty `two`/``/`-1`/`0`, `£` prices and
 * thousands commas, dd/mm/yyyy dates, cancelled rows, a quoted `"Smith, J"`,
 * and three exact duplicates per file. 49 + 43 = 92 data rows, which clean to
 * 66 orders, 20 rejects with reasons, and 6 countries.
 *
 * Edit these and the counts pinned in `__tests__/demo-etl.test.ts` move with them.
 */

export const ORDERS_2026_09_CSV = `order_id,order_date,customer,country,product,qty,unit_price,status
ORD-090001,2026-09-01,Ivy Studio,ES,Doohickey,9,1299.00,PENDING
ORD-090002,2026-09-20,  Fable Books ,FR, Sprocket,7,3.75,PENDING
ORD-090003,2026-09-04,Fable Books,gb,Sprocket,5,3.75,DELIVERED
ORD-090004,2026-09-13,,FR,Sprocket,2,3.75,DELIVERED
ORD-090005,2026-09-25,Bluebird Cafe,IE,Widget,two,12.50,DELIVERED
ORD-090006,2026-09-26,  Acme Ltd ,GB, Gizmo,8,45.00,SHIPPED
ORD-090007,2026-09-18,Ivy Studio, Fr,Gizmo,9,45.00,DELIVERED
ORD-090008,2026-09-12,Evergreen Co,DE,Doohickey,-1,1299.00,SHIPPED
ORD-090009,2026-09-04,Evergreen Co,FR,Sprocket,2,£3.75,DELIVERED
ORD-090010,2026-09-26,  Bluebird Cafe ,GB, Doohickey,7,1299.00,SHIPPED
ORD-090011,2026-09-24,Granite Works,de ,Sprocket,5,3.75,PENDING
ORD-090012,2026-09-05,Granite Works,FR,Doohickey,9,"1,299.00",SHIPPED
ORD-090013,2026-09-17,Harbour Inn,DE,Doohickey,5,"£1,299.00",PENDING
ORD-090014,2026-09-09,  Juniper Bakery ,GB, Doohickey,4,1299.00,PENDING
ORD-090015,2026-09-21,Harbour Inn,Us,Sprocket,1,3.75,PENDING
ORD-090016,21/09/2026,Evergreen Co,IE,Doohickey,4,1299.00,SHIPPED
ORD-090017,13/09/2026,Evergreen Co,FR,Sprocket,8,3.75,DELIVERED
ORD-090018,26/09/2026,Evergreen Co,IE,Gizmo,7,45.00,SHIPPED
ORD-090019,2026-09-08,Juniper Bakery,ie,Widget,6,12.50,DELIVERED
ORD-090020,2026-09-16,Evergreen Co,GB,Widget,9,12.50,CANCELLED
ORD-090021,2026-09-19,"Smith, J",US,Doohickey,5,1299.00,DELIVERED
ORD-090022,2026-09-06,,US,Gadget,9,24.99,DELIVERED
ORD-090023,2026-09-22,Acme Ltd,ES,Doohickey,,1299.00,SHIPPED
ORD-090024,2026-09-02,Juniper Bakery,DE,Gizmo,0,45.00,SHIPPED
ORD-090025,2026-09-08,Evergreen Co,US,Widget,8,12.50,CANCELLED
ORD-090026,2026-09-07,Evergreen Co,US,Sprocket,3,3.75,cancelled
ORD-090027,2026-09-03,Delta Foods,FR,Sprocket,3,3.75,SHIPPED
ORD-090028,2026-09-14,   ,US,Gizmo,7,45.00,PENDING
ORD-090029,2026-09-27,Juniper Bakery,DE,Sprocket,1,3.75,DELIVERED
ORD-090030,2026-09-01,Fable Books,US,Widget,6,12.50,PENDING
ORD-090001,2026-09-01,Ivy Studio,ES,Doohickey,9,1299.00,PENDING
ORD-090031,2026-09-18,Juniper Bakery,ES,Gadget,3,24.99,SHIPPED
ORD-090032,2026-09-09,Bluebird Cafe,GB,Widget,9,12.50,PENDING
ORD-090033,2026-09-16,Carter & Sons,GB,Gizmo,8,45.00,SHIPPED
ORD-090034,2026-09-05,Granite Works,FR,Gadget,4,24.99,SHIPPED
ORD-090035,2026-09-09,Fable Books,US,Gizmo,4,45.00,PENDING
ORD-090036,2026-09-13,Carter & Sons,IE,Sprocket,1,3.75,SHIPPED
ORD-090037,2026-09-14,Juniper Bakery,DE,Sprocket,6,3.75,DELIVERED
ORD-090038,2026-09-28,Juniper Bakery,US,Sprocket,6,3.75,SHIPPED
ORD-090039,2026-09-27,Bluebird Cafe,ES,Widget,4,12.50,DELIVERED
ORD-090040,2026-09-28,Carter & Sons,GB,Gadget,7,24.99,SHIPPED
ORD-090041,2026-09-07,Delta Foods,DE,Gizmo,3,45.00,DELIVERED
ORD-090042,2026-09-03,Harbour Inn,DE,Sprocket,9,3.75,SHIPPED
ORD-090043,2026-09-23,Ivy Studio,ES,Gizmo,3,45.00,SHIPPED
ORD-090044,2026-09-14,Bluebird Cafe,GB,Gadget,8,24.99,DELIVERED
ORD-090045,2026-09-23,Evergreen Co,ES,Sprocket,6,3.75,DELIVERED
ORD-090046,2026-09-12,Delta Foods,GB,Doohickey,3,1299.00,SHIPPED
ORD-090011,2026-09-24,Granite Works,de ,Sprocket,5,3.75,PENDING
ORD-090021,2026-09-19,"Smith, J",US,Doohickey,5,1299.00,DELIVERED
`;

export const ORDERS_2026_10_CSV = `order_id,order_date,customer,country,product,qty,unit_price,status
ORD-100001,2026-10-07,Juniper Bakery,ES,Doohickey,2,1299.00,PENDING
ORD-100002,2026-10-08,  Bluebird Cafe ,FR, Sprocket,2,3.75,DELIVERED
ORD-100003,2026-10-12,Acme Ltd,gb,Widget,7,12.50,SHIPPED
ORD-100004,2026-10-11,,FR,Gadget,3,24.99,DELIVERED
ORD-100005,2026-10-19,Ivy Studio,GB,Widget,two,12.50,DELIVERED
ORD-100006,2026-10-11,  Bluebird Cafe ,ES, Gizmo,8,45.00,SHIPPED
ORD-100007,2026-10-01,Fable Books, Fr,Widget,8,12.50,SHIPPED
ORD-100008,2026-10-19,Granite Works,IE,Gadget,-1,24.99,SHIPPED
ORD-100009,2026-10-14,Bluebird Cafe,ES,Doohickey,1,£1299.00,DELIVERED
ORD-100010,2026-10-12,  Juniper Bakery ,US, Sprocket,9,3.75,DELIVERED
ORD-100011,2026-10-22,Fable Books,de ,Doohickey,3,1299.00,PENDING
ORD-100012,2026-10-20,Ivy Studio,IE,Doohickey,8,"1,299.00",SHIPPED
ORD-100013,2026-10-22,Harbour Inn,FR,Doohickey,4,"£1,299.00",SHIPPED
ORD-100014,2026-10-27,  Delta Foods ,ES, Gadget,7,24.99,DELIVERED
ORD-100015,2026-10-02,Fable Books,Us,Gizmo,7,45.00,SHIPPED
ORD-100016,20/10/2026,Harbour Inn,DE,Doohickey,5,1299.00,SHIPPED
ORD-100017,07/10/2026,Delta Foods,ES,Doohickey,8,1299.00,DELIVERED
ORD-100018,23/10/2026,Delta Foods,GB,Widget,9,12.50,PENDING
ORD-100019,2026-10-05,Ivy Studio,ie,Doohickey,4,1299.00,PENDING
ORD-100020,2026-10-03,Juniper Bakery,FR,Doohickey,1,1299.00,CANCELLED
ORD-100021,2026-10-18,"Smith, J",DE,Gizmo,5,45.00,PENDING
ORD-100022,2026-10-26,,GB,Sprocket,5,3.75,PENDING
ORD-100023,2026-10-25,Acme Ltd,FR,Sprocket,,3.75,PENDING
ORD-100024,2026-10-19,Acme Ltd,ES,Gadget,0,24.99,DELIVERED
ORD-100025,2026-10-21,Acme Ltd,ES,Sprocket,9,3.75,CANCELLED
ORD-100026,2026-10-19,Harbour Inn,DE,Gadget,4,24.99,cancelled
ORD-100027,2026-10-13,Fable Books,US,Widget,6,12.50,PENDING
ORD-100028,2026-10-13,   ,DE,Doohickey,6,1299.00,SHIPPED
ORD-100029,2026-10-03,Delta Foods,FR,Widget,2,12.50,PENDING
ORD-100030,2026-10-01,Delta Foods,GB,Widget,5,12.50,SHIPPED
ORD-100001,2026-10-07,Juniper Bakery,ES,Doohickey,2,1299.00,PENDING
ORD-100031,2026-10-28,Granite Works,GB,Sprocket,2,3.75,SHIPPED
ORD-100032,2026-10-13,Juniper Bakery,DE,Gadget,3,24.99,PENDING
ORD-100033,2026-10-20,Evergreen Co,US,Doohickey,1,1299.00,SHIPPED
ORD-100034,2026-10-10,Carter & Sons,IE,Widget,3,12.50,SHIPPED
ORD-100035,2026-10-15,Delta Foods,IE,Widget,7,12.50,DELIVERED
ORD-100036,2026-10-27,Ivy Studio,FR,Widget,1,12.50,PENDING
ORD-100037,2026-10-09,Ivy Studio,US,Doohickey,8,1299.00,SHIPPED
ORD-100038,2026-10-21,Bluebird Cafe,ES,Doohickey,4,1299.00,SHIPPED
ORD-100039,2026-10-10,Carter & Sons,ES,Gadget,1,24.99,PENDING
ORD-100040,2026-10-18,Carter & Sons,DE,Sprocket,1,3.75,PENDING
ORD-100011,2026-10-22,Fable Books,de ,Doohickey,3,1299.00,PENDING
ORD-100021,2026-10-18,"Smith, J",DE,Gizmo,5,45.00,PENDING
`;

export const LANDING_README_TXT = `Landing folder for the Autonomy studio demo.
Not a CSV: the ingest pipeline's Filter must skip this file.
`;

/** Every landing file the seed writes, by file name. */
export const DEMO_LANDING_FILES: Readonly<Record<string, string>> = {
  'orders_2026-09.csv': ORDERS_2026_09_CSV,
  'orders_2026-10.csv': ORDERS_2026_10_CSV,
  'README.txt': LANDING_README_TXT,
};
