/**
 * KpiCard Component Tests
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { KpiCard } from "../../components/KpiCard";
import { renderWithProviders } from "../setup";

describe("KpiCard", () => {
  it("renders label and value correctly", () => {
    renderWithProviders(
      <KpiCard label="EQUITY" value={10000} unit="$" color="#00ffa3" />
    );

    expect(screen.getByText("EQUITY")).toBeInTheDocument();
    expect(screen.getByText(/10000/)).toBeInTheDocument();
  });

  it("formats number values to 2 decimals", () => {
    renderWithProviders(
      <KpiCard label="APY" value={0.087654} unit="%" color="#00ffa3" />
    );

    expect(screen.getByText(/0.09%/)).toBeInTheDocument();
  });

  it("applies correct size styles", () => {
    const { container } = renderWithProviders(
      <KpiCard label="TEST" value={100} size="lg" color="#00ffa3" />
    );

    const valueElement = container.querySelector("div");
    expect(valueElement).toBeInTheDocument();
  });

  it("renders details text when provided", () => {
    renderWithProviders(
      <KpiCard
        label="PNL"
        value={250}
        unit="$"
        color="#00ffa3"
        details="Realized"
      />
    );

    expect(screen.getByText("Realized")).toBeInTheDocument();
  });

  it("renders spark when provided", () => {
    renderWithProviders(
      <KpiCard
        label="TREND"
        value={100}
        spark={<div>📈</div>}
        color="#00ffa3"
      />
    );

    expect(screen.getByText("📈")).toBeInTheDocument();
  });
});
