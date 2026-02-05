let orderIds = [];

addEventListener('fetch', event => {
  const { request } = event;

  event.respondWith((async () => {
    let jsonData;
    try {
      jsonData = await request.clone().json();
    } catch (err) {
      console.error('Invalid JSON:', err);
      return new Response('Invalid JSON body', { status: 400 });
    }

    // Pass parsed JSON to handler
    event.waitUntil(handleRequest(jsonData));

    // Respond early
    return new Response('OK', { status: 200 });
  })());
});


async function handleRequest(webhookData) {
  const orderId = webhookData?.id;
  if (!orderId) {
    console.error('Missing Order ID');
    return;
  }

  console.log('webhookData', webhookData);

  // Prevent duplicate processing (temporary in-memory check)
  if (orderIds.includes(orderId)) {
    console.log(`CANCEL001: Order ID: ${orderId} has already been processed`);
    return;
  }
  orderIds.push(orderId);

  const tagsFromWebhook = webhookData?.tags || '';
  let hasPreviewTag = tagsFromWebhook.includes('preview-attached');
  let fetchedOrder = null;

  // If the tag isn't present, fetch the full order from Shopify
  if (!hasPreviewTag) {
    fetchedOrder = await fetchOrderFromShopify(orderId);
    console.log('fetchedOrder', fetchedOrder);
    console.log('fetchedOrderAddress', fetchedOrder?.shipping_address);

    if (fetchedOrder?.tags?.includes('preview-attached')) {
      hasPreviewTag = true;
    } else {
      const tagUpdateResult = await addTagToOrder(orderId, 'preview-attached');
      if (tagUpdateResult.error) {
        console.error(tagUpdateResult.error);
        return;
      }
    }
  }

  if (hasPreviewTag) {
    console.log('CANCEL003: Preview already attached, skipping PDF generation.');
    return;
  }

  if (!fetchedOrder) return;

  const pdfShiftResponse = await generatePDF(webhookData.line_items, orderId);
  if (pdfShiftResponse.error) {
    console.error(pdfShiftResponse.error);
    return;
  }

  console.log('PDF rendered:', orderId);
  const pdfUrl = pdfShiftResponse.url;

  const attachResponse = await attachPreviewLinkToOrder(orderId, pdfUrl);
  if (attachResponse.error) {
    console.error(attachResponse.error);
    return;
  }

  const melResponse = await sendToMelAPI(webhookData, fetchedOrder, pdfUrl);
  if (melResponse.error) {
    console.error(melResponse.error);
  }
}


// --- Helper Functions ---

async function fetchOrderFromShopify(orderId) {
  const url = `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${WEBHOOK_VERSION}/orders/${orderId}.json`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    const json = await res.json();
    return json.order;
  } catch (err) {
    console.error('Failed to fetch order:', err);
    return null;
  }
}

async function addTagToOrder(orderId, newTag) {
  const url = `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${WEBHOOK_VERSION}/orders/${orderId}.json`;

  try {
    const order = await fetchOrderFromShopify(orderId);
    const updatedTags = order?.tags ? `${order.tags}, ${newTag}` : newTag;

    const payload = {
      order: {
        id: orderId,
        tags: updatedTags,
      },
    };

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return { error: `Failed to update tags: ${errorText}` };
    }

    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
}

async function generatePDF(line_items, orderId) {
  const lineItem = line_items[0];
  let previewProperty = lineItem?.properties?.find(prop => prop.name === '_preview')?.value;

  if (!previewProperty) {
    return { error: 'No _preview property found on the line item' };
  }

  previewProperty = previewProperty.replace('https://notednotebooks.com/', 'https://7rrh4r1mrr4rlf39-68431380629.shopifypreview.com/');
  previewProperty = previewProperty.replace('&preview=true', '');

  const params = {
    source: previewProperty,
    filename: `BYB-file-${orderId}.pdf`,
    landscape: false,
    sandbox: true,
    format: "7.25inx9.25in"
  };

  const pdfShiftUrl = 'https://api.pdfshift.io/v3/convert/pdf';

  try {
    const response = await fetch(pdfShiftUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa('api:' + PDFShift_API_KEY)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    const textResponse = await response.text();
    if (!textResponse) return { error: 'Empty response from PDFShift API' };

    const data = JSON.parse(textResponse);
    if (response.ok && data.url) {
      return { url: data.url };
    } else {
      return { error: `Failed to generate PDF: ${data.error || 'Unknown error'}` };
    }
  } catch (error) {
    return { error: error.message };
  }
}

async function attachPreviewLinkToOrder(orderId, fileLink) {
  const orderApiUrl = `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${WEBHOOK_VERSION}/orders/${orderId}.json`;

  const orderPayload = {
    order: {
      id: orderId,
      metafields: [
        {
          key: "preview_link",
          value: fileLink,
          type: "url",
          namespace: "custom"
        }
      ]
    }
  };

  try {
    const response = await fetch(orderApiUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify(orderPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { error: `Failed to attach Preview Link: ${errorText}` };
    }

    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
}
async function sendToMelAPI(webhookData, order, pdfUrl) {
  const shippingAddress = webhookData.shipping_address;
  const lineItem = webhookData.line_items[0];
  const coverImage = lineItem?.properties?.find(prop => prop.name === '_cover-image')?.value;

  const payload = {
    fulfillment: {
      customerReference: `Order${order.name}`,
      shippingInfo: {
        deliveryName: `${shippingAddress.first_name} ${shippingAddress.last_name}`,
        delveryCompany: shippingAddress.company || "",
        deliveryAdd1: shippingAddress.address1 || "",
        deliveryAdd2: shippingAddress.address2 || "",
        deliveryCity: shippingAddress.city || "",
        deliveryState: shippingAddress.province_code || "",
        deliveryZip: shippingAddress.zip || "",
        deliveryCountry: shippingAddress.country_code || "",
        shippingMethod: "Economy"
      },
      Products: order.line_items.map((item) => ({
        productSku: item.sku,
        qty: item.quantity,
        sellPrice: item.price,
        coverFileURL: coverImage || "",
        insidePagesURL: pdfUrl || "",
        coverSubstrate: "Cover_12pt_C1S-Gloss_2600x2000",
        insideSubstrate: "Text_70lb_Offset_2950x2081"
      }))
    }
  };

  const response = await fetch('https://poweredbymel.com/API/PostFulfillment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MEL_API_TOKEN}`
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();

  // Clean up MEL's malformed response
  const jsonStartIndex = raw.indexOf('{');
  let result;

  if (jsonStartIndex !== -1) {
    try {
      const cleanJson = raw.slice(jsonStartIndex);
      result = JSON.parse(cleanJson);
    } catch (e) {
      console.warn('Failed to parse MEL JSON:', raw);
      return { error: `MEL API returned invalid JSON: ${raw}` };
    }
  } else {
    return { error: `MEL API returned no JSON content: ${raw}` };
  }

  if (!response.ok || result.status === 'error') {
    console.error('MEL API error:', result);
    return { error: result.message || `MEL API failed with status ${response.status}` };
  }

  console.log('SUCCESS SENT TO MEL', payload);
  return result;
}
