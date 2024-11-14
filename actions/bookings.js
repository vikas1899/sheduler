"use server";

import { db } from "@/lib/prisma";
import { clerkClient } from "@clerk/nextjs/server";
import { google } from "googleapis";

// Custom error class for OAuth-related errors
class OAuthError extends Error {
  constructor(message, code, clerkError = null) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.clerkError = clerkError;
  }
}

/**
 * Fetches and validates Google OAuth token from Clerk
 * @param {string} clerkUserId - Clerk user ID
 * @returns {Promise<string>} Valid OAuth token
 */
async function getGoogleOAuthToken(clerkUserId) {
  try {
    // Use the function call syntax as per deprecation warning
    const clerk = clerkClient();
    const { data } = await clerk.users.getUserOauthAccessToken(
      clerkUserId,
      "oauth_google"
    );

    const token = data[0]?.token;
    
    if (!token) {
      throw new OAuthError(
        "Google Calendar not connected",
        "NO_GOOGLE_CONNECTION"
      );
    }

    return token;
  } catch (error) {
    if (error.code === 'oauth_token_retrieval_error') {
      // Handle expired or invalid tokens
      throw new OAuthError(
        "Please reconnect your Google Calendar",
        "GOOGLE_AUTH_REQUIRED",
        error
      );
    }
    
    throw new OAuthError(
      "Failed to access Google Calendar",
      "GOOGLE_AUTH_ERROR",
      error
    );
  }
}

/**
 * Creates a Google Calendar event with error handling
 * @param {Object} params - Event parameters
 * @returns {Promise<Object>} Created event details
 */
async function createGoogleCalendarEvent({
  token,
  summary,
  description,
  startTime,
  endTime,
  attendees,
  eventId
}) {
  try {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: token });
    
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    
    const response = await calendar.events.insert({
      calendarId: "primary",
      conferenceDataVersion: 1,
      requestBody: {
        summary,
        description,
        start: { dateTime: startTime },
        end: { dateTime: endTime },
        attendees,
        conferenceData: {
          createRequest: { requestId: `${eventId}-${Date.now()}` },
        },
      },
    });

    return {
      meetLink: response.data.hangoutLink,
      googleEventId: response.data.id,
    };
  } catch (error) {
    if (error.code === 401) {
      throw new OAuthError(
        "Google Calendar access expired",
        "GOOGLE_TOKEN_EXPIRED"
      );
    }
    throw new Error("Failed to create Google Calendar event");
  }
}

export async function createBooking(bookingData) {
  try {
    // 1. Fetch the event and its creator
    const event = await db.event.findUnique({
      where: { id: bookingData.eventId },
      include: { user: true },
    });

    if (!event) {
      return { 
        success: false, 
        error: "Event not found" 
      };
    }

    // 2. Get and validate Google OAuth token
    let token;
    try {
      token = await getGoogleOAuthToken(event.user.clerkUserId);
    } catch (oauthError) {
      return {
        success: false,
        error: oauthError.message,
        code: oauthError.code,
        requiresReauth: oauthError.code === 'GOOGLE_AUTH_REQUIRED',
      };
    }

    // 3. Create Google Calendar event
    let googleEvent;
    try {
      googleEvent = await createGoogleCalendarEvent({
        token,
        summary: `${bookingData.name} - ${event.title}`,
        description: bookingData.additionalInfo,
        startTime: bookingData.startTime,
        endTime: bookingData.endTime,
        attendees: [
          { email: bookingData.email },
          { email: event.user.email }
        ],
        eventId: event.id
      });
    } catch (calendarError) {
      if (calendarError instanceof OAuthError) {
        return {
          success: false,
          error: "Failed to create calendar event. Please reconnect Google Calendar.",
          code: calendarError.code,
          requiresReauth: true,
        };
      }
      throw calendarError;
    }

    // 4. Create booking in database
    const booking = await db.booking.create({
      data: {
        eventId: event.id,
        userId: event.userId,
        name: bookingData.name,
        email: bookingData.email,
        startTime: bookingData.startTime,
        endTime: bookingData.endTime,
        additionalInfo: bookingData.additionalInfo,
        meetLink: googleEvent.meetLink,
        googleEventId: googleEvent.googleEventId,
      },
    });

    return {
      success: true,
      booking,
      meetLink: googleEvent.meetLink,
    };
    
  } catch (error) {
    console.error("Error creating booking:", error);
    
    return {
      success: false,
      error: "Failed to create booking",
      details: error.message,
    };
  }
}