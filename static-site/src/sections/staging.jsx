import React from "react";
import {
  SmallSpacer,
  HugeSpacer,
  FlexCenter,
} from "../layouts/generalComponents";
import * as splashStyles from "../components/splash/styles";
import DatasetSelect from "../components/Datasets/dataset-select";
import { getDatasetsAndNarratives } from "./pathogens";
import GenericPage from "../layouts/generic-page";

const nextstrainLogoPNG = require("../../static/logos/favicon.png");

const title = "Staging Datasets";
const abstract = `This page details staging (i.e. not yet released) datasets maintained by the Nextstrain team.`;


const tableColumns = [
  {
    name: "Dataset",
    value: (dataset) => dataset.name,
    url: (dataset) => dataset.url
  },
  {
    name: "Type",
    value: (dataset) => dataset.type
  },
  {
    name: "Contributor",
    value: () => "Nextstrain",
    valueMobile: () => "",
    url: () => "https://nextstrain.org",
    logo: () => (<img alt="nextstrain.org" className="logo" width="24px" src={nextstrainLogoPNG}/>)
  }
];


class Index extends React.Component {
  constructor(props) {
    super(props);
    this.state = {data: undefined, errorFetchingData: false};
  }

  async componentDidMount() {
    try {
      const data = await getDatasetsAndNarratives("/charon/getAvailable?prefix=/staging");
      this.setState({data});
    } catch (err) {
      console.error("Error fetching / parsing data.", err.message);
      this.setState({errorFetchingData: true});
    }
  }

  render() {
    return (
      <GenericPage location={this.props.location}>
        <splashStyles.H1>{title}</splashStyles.H1>
        <SmallSpacer />

        <FlexCenter>
          <splashStyles.CenteredFocusParagraph>
            {abstract}
          </splashStyles.CenteredFocusParagraph>
        </FlexCenter>
        <HugeSpacer /> <HugeSpacer />

        {this.state.data && (
          <DatasetSelect
            datasets={this.state.data}
            columns={tableColumns}
            urlDefinedFilterPath={this.props["*"]}
          />
        )}
        {this.state.errorFetchingData && (
          <splashStyles.CenteredFocusParagraph>
            Something went wrong getting data.
            Please <a href="mailto:hello@nextstrain.org">contact us at hello@nextstrain.org </a>
            if this continues to happen.
          </splashStyles.CenteredFocusParagraph>
        )}
      </GenericPage>
    );
  }
}

export default Index;
